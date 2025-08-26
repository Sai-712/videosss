import React, { useState, useEffect, useContext, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Camera, Image, Video, Users, Plus, X, Trash2, Copy, RefreshCw, CheckCircle, Edit, QrCode, Download, Search, Filter, Check } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { 
    storeEventData, 
    getEventStatistics, 
    getUserEvents, 
    EventData, 
    deleteEvent, 
    getEventsByOrganizerId,
    getEventsByUserId,
    getEventById,
    updateEventsWithOrganizationCode,
    updateOrganizationNameAcrossEvents
} from '../config/eventStorage';
import s3ClientPromise, { validateEnvVariables } from '../config/aws';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { UserContext } from '../App';
import { storeUserCredentials, getUserByEmail, queryUserByEmail, getEventAttendeeCount } from '../config/dynamodb';
import { ObjectCannedACL } from '@aws-sdk/client-s3';
import heic2any from 'heic2any';

// Initialize S3 bucket name
let s3BucketName: string = '';

interface Event {
    id: string;
    name: string;
    date: string;
    description?: string;
    coverImage?: File;
}

interface StatsCardProps {
    icon: React.ReactNode;
    title: string;
    count: number;
    bgColor: string;
    className?: string;
    titleColor?: string;
}

const StatsCard: React.FC<StatsCardProps> = ({ icon, title, count, bgColor, className, titleColor }) => (
    <div className={`${bgColor} p-2 sm:p-2.5 rounded-lg shadow-md flex items-center space-x-2 ${className || ''}`}>
        <div className="p-1.5 bg-white rounded-full">{icon}</div>
        <div>
            <h3 className={`text-xs font-semibold truncate ${titleColor || 'text-blue-900'}`}>{title}</h3>
            <p className="text-sm sm:text-base font-bold text-black">{count}</p>
        </div>
    </div>
);

interface EventDashboardProps {
    setShowNavbar: (show: boolean) => void;
}

// Function to generate a unique 6-digit event ID
const generateUniqueEventId = async (): Promise<string> => {
    const generateSixDigitId = (): string => {
        // Generate a random 6-digit number
        return Math.floor(100000 + Math.random() * 900000).toString();
    };
    
    // Generate an initial ID
    let eventId = generateSixDigitId();
    
    // Check if the ID already exists in the database
    // If it does, generate a new one until we find a unique ID
    let isUnique = false;
    let maxAttempts = 10; // Prevent infinite loops
    let attempts = 0;
    
    while (!isUnique && attempts < maxAttempts) {
        attempts++;
        try {
            // Check if an event with this ID already exists
            const existingEvent = await getEventById(eventId);
            
            if (!existingEvent) {
                // ID is unique
                isUnique = true;
            } else {
                // ID exists, generate a new one
                console.log(`Event ID ${eventId} already exists, generating a new one...`);
                eventId = generateSixDigitId();
            }
        } catch (error) {
            console.error('Error checking event ID uniqueness:', error);
            // If there's an error checking, assume it's unique to avoid getting stuck
            isUnique = true;
        }
    }
    
    if (attempts >= maxAttempts) {
        console.warn('Reached maximum attempts to generate a unique ID');
    }
    
    return eventId;
};

const MAX_COVER_IMAGE_SIZE = 500 * 1024 * 1024; // 500MB

const EventDashboard = (props: EventDashboardProps) => {
    const navigate = useNavigate();
    const { userEmail, userRole, setUserRole } = useContext(UserContext);
    const [deleteConfirmation, setDeleteConfirmation] = useState<{isOpen: boolean; eventId: string; userEmail: string}>({isOpen: false, eventId: '', userEmail: ''});

    const [isModalOpen, setIsModalOpen] = useState(false);
    const [newEvent, setNewEvent] = useState<Event>({ id: '', name: '', date: '' });
    const [coverImagePreview, setCoverImagePreview] = useState<string | null>(null);

    const [stats, setStats] = useState({ eventCount: 0, photoCount: 0, videoCount: 0, guestCount: 0, attendeeCount: 0 });
    const [isLoading, setIsLoading] = useState(false);
    const [events, setEvents] = useState<EventData[]>([]);
    const [showAllEvents, setShowAllEvents] = useState(true);
    const [copiedEventId, setCopiedEventId] = useState<string | null>(null);
    const [eventAttendeeCounts, setEventAttendeeCounts] = useState<Record<string, number>>({});
    const [refreshInterval, setRefreshInterval] = useState<NodeJS.Timeout | null>(null);

    const [userProfile, setUserProfile] = useState<any>(null);
    const [copiedCode, setCopiedCode] = useState(false);
    // Change sortOption state to allow 'default'
    const [sortOption, setSortOption] = useState<'name' | 'name-desc' | 'date' | 'date-desc'>('date');
    const [showQRCode, setShowQRCode] = useState(false);

    // State for event editing
    const [editMode, setEditMode] = useState<{eventId: string; type: 'name' | 'date' | 'coverImage'} | null>(null);
    const [editedName, setEditedName] = useState('');

    // State for image orientations
    // Image orientations state (currently unused but kept for future use)
    const [, setImageOrientations] = useState<Record<string, 'landscape' | 'portrait' | 'unknown'>>({});

    // State for organization logo upload
    const [isUploadingOrgLogo, setIsUploadingOrgLogo] = useState(false);

    // State for organization name editing
    const [isEditingOrgName, setIsEditingOrgName] = useState(false);
    const [editedOrgName, setEditedOrgName] = useState('');
    
    // State for editing event date
    const [editedDate, setEditedDate] = useState('');
    const [isUpdatingOrgName, setIsUpdatingOrgName] = useState(false);

    // Add search state
    const [searchQuery, setSearchQuery] = useState('');

    // Update sorting logic to handle all sort options
    const sortedEvents = React.useMemo(() => {
        if (sortOption === 'name') {
            return [...events].sort((a, b) => a.name.localeCompare(b.name));
        } else if (sortOption === 'name-desc') {
            return [...events].sort((a, b) => b.name.localeCompare(a.name));
        } else if (sortOption === 'date') {
            return [...events].sort((a, b) => {
                try {
                    const dateA = parseDate(a.date);
                    const dateB = parseDate(b.date);
                    return dateA.getTime() - dateB.getTime(); // Oldest first
                } catch (error) {
                    return 0; // Keep original order if parsing fails
                }
            });
        } else { // date-desc (Latest first)
            return [...events].sort((a, b) => {
                try {
                    const dateA = parseDate(a.date);
                    const dateB = parseDate(b.date);
                    return dateB.getTime() - dateA.getTime(); // Latest first
                } catch (error) {
                    return 0; // Keep original order if parsing fails
                }
            });
        }
    }, [events, sortOption]);

    // Filter events based on search query
    const filteredEvents = React.useMemo(() => 
        sortedEvents.filter(event =>
            event.name.toLowerCase().includes(searchQuery.toLowerCase())
        ),
        [sortedEvents, searchQuery]
    );

    const qrRef = useRef<SVGSVGElement | null>(null);

    useEffect(() => {
        loadEvents();

        // Check URL query parameters for 'create=true'
        const urlParams = new URLSearchParams(window.location.search);
        if (urlParams.get('create') === 'true') {
            // Update user role to organizer when directed to create event
            const updateUserRole = async () => {
                const email = localStorage.getItem('userEmail');
                if (email) {
                    // Get user info from localStorage
                    let name = '';
                    const userProfileStr = localStorage.getItem('userProfile');
                    if (userProfileStr) {
                        try {
                            const userProfile = JSON.parse(userProfileStr);
                            name = userProfile.name || '';
                        } catch (e) {
                            console.error('Error parsing user profile from localStorage', e);
                        }
                    }
                    
                    const mobile = localStorage.getItem('userMobile') || '';
                    
                    // Update user role to organizer
                    await storeUserCredentials({
                        userId: email,
                        email,
                        name,
                        mobile,
                        role: 'organizer'
                    });
                    
                    // Update local context
                    setUserRole('organizer');

                    // Get the updated user data to get the organization code
                    const userData = await getUserByEmail(email);
                    if (userData?.organizationCode) {
                        // Update existing events with the organization code
                        await updateEventsWithOrganizationCode(email, userData.organizationCode);
                        console.log('Updated existing events with organization code:', userData.organizationCode);
                    }
                }
            };
            
            updateUserRole();
            setIsModalOpen(true);
            // Remove the parameter from URL without refreshing
            navigate('/events', { replace: true });
        }
    }, [navigate, setUserRole]);

    // Add effect to update statistics periodically and when component is visible
    useEffect(() => {
        // Initial load
        loadEventStatistics();
        
        // Set up refresh interval when component mounts
        const interval = setInterval(() => {
            if (document.visibilityState === 'visible') {
                loadEventStatistics();
            }
        }, 2000); // Refresh every 2 seconds when visible for more responsive updates
        
        setRefreshInterval(interval);
        
        // Add visibility change listener to refresh data when coming back to page
        const handleVisibilityChange = () => {
            if (document.visibilityState === 'visible') {
                console.log('Tab became visible, refreshing statistics...');
                loadEventStatistics();
            }
        };
        
        document.addEventListener('visibilitychange', handleVisibilityChange);
        
        // Force refresh on focus
        const handleFocus = () => {
            console.log('Window focused, refreshing statistics...');
            loadEventStatistics();
        };
        
        window.addEventListener('focus', handleFocus);
        
        // Clean up
        return () => {
            clearInterval(interval); // Clear using the local interval variable
            document.removeEventListener('visibilitychange', handleVisibilityChange);
            window.removeEventListener('focus', handleFocus);
        };
    }, []);  // Empty dependency array - only run on mount and unmount

    // Fix the detectImageOrientation function with proper typing
    const detectImageOrientation = (imageUrl: string, eventId: string): void => {
        const img = document.createElement('img');
        img.onload = () => {
            // Compare width and height to determine orientation
            const orientation = img.width >= img.height ? 'landscape' : 'portrait';
            setImageOrientations(prev => ({
                ...prev,
                [eventId]: orientation
            }));
            
        };
        img.onerror = () => {
            // Set unknown if image fails to load
            setImageOrientations(prev => ({
                ...prev,
                [eventId]: 'unknown'
            }));
            console.error(`Failed to load image for orientation detection: ${imageUrl}`);
        };
        // Use a single consistent timestamp to prevent flickering
        img.src = `${imageUrl}?cache=${Date.now()}`;
    };

    // Function to load attendee counts for all events
    const loadEventAttendeeCounts = async (eventList: EventData[]) => {
        try {
            const counts: Record<string, number> = {};
            
            // Load attendee counts for each event in parallel
            const countPromises = eventList.map(async (event) => {
                try {
                    const count = await getEventAttendeeCount(event.id);
                    counts[event.id] = count;
                } catch (error) {
                    console.error(`Error loading attendee count for event ${event.id}:`, error);
                    counts[event.id] = 0;
                }
            });
            
            await Promise.all(countPromises);
            setEventAttendeeCounts(counts);
            console.log('Event attendee counts loaded:', counts);
        } catch (error) {
            console.error('Error loading event attendee counts:', error);
        }
    };

    // Function to refresh attendee count for a specific event
    const refreshEventAttendeeCount = async (eventId: string) => {
        try {
            const count = await getEventAttendeeCount(eventId);
            setEventAttendeeCounts(prev => ({
                ...prev,
                [eventId]: count
            }));
            console.log(`Attendee count refreshed for event ${eventId}:`, count);
        } catch (error) {
            console.error(`Error refreshing attendee count for event ${eventId}:`, error);
        }
    };

    const loadEvents = async () => {
        try {
            const userEmail = localStorage.getItem('userEmail');
            if (!userEmail) {
                console.error('User email not found');
                return;
            }
            
            // Only get events where user is the organizer (organizerId field)
            const organizerEvents = await getEventsByOrganizerId(userEmail);
            
            // Use only organizer events
            const allEvents = [...organizerEvents];
            
            if (Array.isArray(allEvents)) {
                // Calculate statistics directly from loaded events
                const newStats = {
                    eventCount: allEvents.length,
                    photoCount: allEvents.reduce((sum, event) => sum + (event.photoCount || 0), 0),
                    videoCount: allEvents.reduce((sum, event) => sum + (event.videoCount || 0), 0),
                    guestCount: allEvents.reduce((sum, event) => sum + (event.guestCount || 0), 0),
                };
                
                // Check if stats actually changed before updating state to prevent unnecessary renders
                const statsChanged = 
                    newStats.eventCount !== stats.eventCount ||
                    newStats.photoCount !== stats.photoCount ||
                    newStats.videoCount !== stats.videoCount ||
                    newStats.guestCount !== stats.guestCount;
                    
                if (statsChanged) {
                    console.log('Statistics updated:', newStats);
                    setStats(prev => ({ ...newStats, attendeeCount: prev.attendeeCount }));
                }
                
                // Check if events have changed before updating state
                const eventsChanged = allEvents.length !== events.length;
                if (eventsChanged) {
                    setEvents(allEvents);
                    console.log('Events updated:', allEvents.length);
                    
                    // Load attendee counts for all events
                    loadEventAttendeeCounts(allEvents);
                    
                    // Detect orientation for all event cover images
                    allEvents.forEach(event => {
                        if (event.coverImage) {
                            detectImageOrientation(event.coverImage, event.id);
                        }
                    });
                }
            } else {
                console.error('Invalid events data received');
            }
        } catch (error) {
            console.error('Error loading events:', error);
        }
    };

    const loadEventStatistics = async () => {
        try {
            const userEmail = localStorage.getItem('userEmail');
            if (userEmail) {
                console.log('Loading statistics for user:', userEmail);
                // Load events which will automatically update statistics
                await loadEvents();
            }
        } catch (error) {
            console.error('Error loading event statistics:', error);
            // Set default stats on error
            setStats({
                eventCount: 0,
                photoCount: 0,
                videoCount: 0,
                guestCount: 0,
                attendeeCount: 0
            });
        }
    };

    // Always convert to .jpg extension, including HEIC/HEIF support
    const handleCoverImageChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      // Helper to convert any image to JPEG with .jpg extension
      const convertToJpg = (file: File): Promise<File> => {
        return new Promise(async (resolve, reject) => {
          const fileName = file.name.toLowerCase();
          const isHeicHeif = fileName.endsWith('.heic') || fileName.endsWith('.heif') || file.type === 'image/heic' || file.type === 'image/heif';
          if (isHeicHeif) {
            try {
              // Use heic2any to convert HEIC/HEIF to JPEG
              const jpegBlob = await heic2any({
                blob: file,
                toType: 'image/jpeg',
                quality: 0.9,
              }) as Blob;
              const jpgFile = new File([jpegBlob], file.name.replace(/\.[^.]+$/, '.jpg'), { type: 'image/jpeg' });
              resolve(jpgFile);
              return;
            } catch (err) {
              reject(new Error('Failed to convert HEIC/HEIF image to JPG'));
              return;
            }
          }
          // For other image types, use canvas
          const reader = new FileReader();
          reader.onload = (event) => {
            const img = new window.Image();
            img.onload = () => {
              const canvas = document.createElement('canvas');
              canvas.width = img.width;
              canvas.height = img.height;
              const ctx = canvas.getContext('2d');
              if (!ctx) return reject(new Error('Failed to get canvas context'));
              ctx.drawImage(img, 0, 0);
              canvas.toBlob((blob) => {
                if (!blob) return reject(new Error('Failed to convert image to JPG'));
                const jpgFile = new File([blob], file.name.replace(/\.[^.]+$/, '.jpg'), { type: 'image/jpeg' });
                resolve(jpgFile);
              }, 'image/jpeg', 0.9);
            };
            img.onerror = reject;
            img.src = event.target?.result as string;
          };
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });
      };

      let jpgFile;
      try {
        jpgFile = await convertToJpg(file);
      } catch (err) {
        alert('Failed to convert image to JPG. Please try another image.');
        return;
      }

      // Set the preview and update state with the JPG file
      const reader = new FileReader();
      reader.onload = (event) => {
        setCoverImagePreview(event.target?.result as string);
        setNewEvent(prev => ({ ...prev, coverImage: jpgFile }));
      };
      reader.readAsDataURL(jpgFile);
    };

    const handleOpenCreateModal = async () => {
        try {
            // Hide navbar immediately when opening create event modal
            props.setShowNavbar(false);
            
            // Update user role if needed
            if (userRole !== 'organizer') {
                console.log('Updating user role to organizer');
                const email = localStorage.getItem('userEmail');
                if (email) {
                    // Get user info from localStorage
                    let name = '';
                    const userProfileStr = localStorage.getItem('userProfile');
                    if (userProfileStr) {
                        try {
                            const userProfile = JSON.parse(userProfileStr);
                            name = userProfile.name || '';
                        } catch (e) {
                            console.error('Error parsing user profile from localStorage', e);
                        }
                    }
                    
                    const mobile = localStorage.getItem('userMobile') || '';
                    
                    // Update user role to organizer
                    await storeUserCredentials({
                        userId: email,
                        email,
                        name,
                        mobile,
                        role: 'organizer'
                    });
                    
                    // Update local context
                    setUserRole('organizer');
                    console.log('User role updated to organizer');
                }
            }
        } catch (error) {
            console.error('Error updating user role:', error);
        }
        
        // Open the modal
        setIsModalOpen(true);
    };

    const compressImage = async (file: File): Promise<Blob> => {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => {
                const img: HTMLImageElement = new window.Image();
                img.onload = () => {
                    const canvas = document.createElement('canvas');
                    const ctx = canvas.getContext('2d');
                    if (!ctx) {
                        reject(new Error('Failed to get canvas context'));
                        return;
                    }
                    // Calculate new dimensions while maintaining aspect ratio
                    let width = img.width;
                    let height = img.height;
                    const maxDimension = 1200;
                    if (width > maxDimension || height > maxDimension) {
                        if (width > height) {
                            height = (height / width) * maxDimension;
                            width = maxDimension;
                        } else {
                            width = (width / height) * maxDimension;
                            height = maxDimension;
                        }
                    }
                    canvas.width = width;
                    canvas.height = height;
                    ctx.drawImage(img, 0, 0, width, height);
                    canvas.toBlob(
                        (blob) => {
                            if (blob) {
                                resolve(blob);
                            } else {
                                reject(new Error('Failed to compress image'));
                            }
                        },
                        'image/jpeg',
                        0.8
                    );
                };
                img.onerror = () => reject(new Error('Failed to load image'));
                img.src = e.target?.result as string;
            };
            reader.onerror = () => reject(new Error('Failed to read file'));
            reader.readAsDataURL(file);
        });
    };

    // Utility function to format date as dd/mm/yy
    const formatDateDDMMYY = (dateString: string) => {
        if (!dateString) return '';
        const date = new Date(dateString);
        if (isNaN(date.getTime())) return dateString;
        const day = String(date.getDate()).padStart(2, '0');
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const year = String(date.getFullYear()).slice(-2);
        return `${day}/${month}/${year}`;
    };

    // Simple utility function to parse DD/MM/YY format dates
    const parseDate = (dateString: string): Date => {
        if (!dateString) return new Date(0);
        
        try {
            // Check if it's in DD/MM/YY format
            if (dateString.includes('/')) {
                const parts = dateString.split('/');
                if (parts.length === 3) {
                    let [day, month, year] = parts;
                    
                    // Convert 2-digit year to 4-digit
                    if (year.length === 2) {
                        const twoDigitYear = parseInt(year);
                        year = (twoDigitYear >= 30 ? '19' : '20') + year;
                    }
                    
                    // Create date as YYYY-MM-DD
                    return new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
                }
            }
            
            // Fallback to direct parsing
            return new Date(dateString);
        } catch (error) {
            return new Date(0);
        }
    };

    const handleCreateEvent = async (e: React.FormEvent) => {
        e.preventDefault();
        console.log('Starting event creation process...');
        const { bucketName } = await validateEnvVariables();

        if (!newEvent.name || !newEvent.date || !newEvent.coverImage) {
            console.log('Validation failed:', { name: newEvent.name, date: newEvent.date, coverImage: !!newEvent.coverImage });
            alert('Please fill in all required fields including cover image');
            return;
        }

        setIsLoading(true);
        props.setShowNavbar(false);

        try {
            const userEmail = localStorage.getItem('userEmail');
            if (!userEmail) {
                console.error('User not authenticated - no email found in localStorage');
                throw new Error('User not authenticated');
            }
            console.log('User authenticated:', userEmail);

            // Generate a unique 6-digit event ID
            const eventId = await generateUniqueEventId();
            console.log('Generated event ID:', eventId);

            // Handle cover image upload first
            let coverImageUrl = '';
            if (newEvent.coverImage) {
                console.log('Starting cover image upload...');
                const coverImageKey = `events/shared/${eventId}/cover.jpg`;
                console.log('Cover image key:', coverImageKey);
                try {
                    // Compress the cover image before uploading
                    const compressedCoverImage = await compressImage(newEvent.coverImage);
                    // Upload directly to S3 using PutObjectCommand
                    const uploadCommand = new PutObjectCommand({
                        Bucket: bucketName,
                        Key: coverImageKey,
                        Body: new Uint8Array(await compressedCoverImage.arrayBuffer()),
                        ContentType: 'image/jpeg',
                        ACL: 'public-read' as ObjectCannedACL
                    });
                    console.log('Sending upload command to S3...');
                    await (await s3ClientPromise).send(uploadCommand);
                    console.log('S3 upload completed successfully');
                    coverImageUrl = `https://${bucketName}.s3.amazonaws.com/${coverImageKey}`;
                    console.log('Cover image URL:', coverImageUrl);
                } catch (uploadError) {
                    console.error('Error uploading cover image:', uploadError);
                    throw new Error('Failed to upload cover image. Please try again.');
                }
            }

            // Update user role and create event data
            try {
                // Get user info from localStorage
                let name = '';
                const userProfileStr = localStorage.getItem('userProfile');
                if (userProfileStr) {
                    try {
                        const userProfile = JSON.parse(userProfileStr);
                        name = userProfile.name || '';
                    } catch (e) {
                        console.error('Error parsing user profile from localStorage', e);
                    }
                }
                
                const mobile = localStorage.getItem('userMobile') || '';
                console.log('User profile loaded:', { name, mobile });

                // Get existing user data
                const existingUser = await getUserByEmail(userEmail);
                console.log('Retrieved existing user data:', existingUser);
                let eventIds: string[] = [];
                
                if (existingUser?.createdEvents && Array.isArray(existingUser.createdEvents)) {
                    eventIds = [...existingUser.createdEvents];
                }
                
                eventIds.push(eventId);
                
                // Update user role and createdEvents
                await storeUserCredentials({
                    userId: userEmail,
                    email: userEmail,
                    name,
                    mobile,
                    role: 'organizer',
                    createdEvents: eventIds
                });
                
                setUserRole('organizer');

                // Create event data
                const eventData: EventData = {
                    id: eventId,
                    name: newEvent.name,
                    date: formatDateDDMMYY(newEvent.date),
                    description: newEvent.description,
                    coverImage: coverImageUrl,
                    photoCount: 0,
                    videoCount: 0,
                    guestCount: 0,
                    userEmail,
                    organizerId: userEmail,
                    userId: userEmail,
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                    eventUrl: `${window.location.origin}/attendee-dashboard?eventId=${eventId}`
                };

                // Store event data
                console.log('Storing event data...');
                const success = await storeEventData(eventData);
                
                if (success) {
                    console.log('Event created successfully');
                    await loadEventStatistics();
                    await loadEvents();
                    setIsModalOpen(false);
                    setNewEvent({ id: '', name: '', date: '', description: '' });
                    setCoverImagePreview(null);
                    props.setShowNavbar(true);
                    
                    // Navigate directly to the upload images page
                    console.log('Navigating to upload images page:', `/upload-image?eventId=${eventId}`);
                    navigate(`/upload-image?eventId=${eventId}`);
                } else {
                    throw new Error('Failed to store event data');
                }
            } catch (error) {
                console.error('Error in event creation process:', error);
                throw error;
            }
        } catch (error: any) {
            console.error('Error creating event:', error);
            alert(error.message || 'Failed to create event. Please try again.');
        } finally {
            setIsLoading(false);
        }
    };

    const handleConfirmDelete = async () => {
        if (deleteConfirmation.eventId && deleteConfirmation.userEmail) {
            try {
                const success = await deleteEvent(deleteConfirmation.eventId, deleteConfirmation.userEmail);
                if (success) {
                    // After successful deletion from DynamoDB
                    loadEvents();
                    loadEventStatistics();
                    setDeleteConfirmation({isOpen: false, eventId: '', userEmail: ''});
                } else {
                    alert('Failed to delete event. Please try again.');
                }
            } catch (error) {
                console.error('Error deleting event:', error);
                alert('An error occurred while deleting the event.');
            }
        }
    };

    const handleDeleteClick = (eventId: string, userEmail: string) => {
        setDeleteConfirmation({isOpen: true, eventId, userEmail});
    };

    const handleCopyEventId = (eventId: string) => {
        navigator.clipboard.writeText(eventId);
        setCopiedEventId(eventId);
        setTimeout(() => setCopiedEventId(null), 2000);
    };

    useEffect(() => {
        const fetchUserProfile = async () => {
            try {
                const userEmail = localStorage.getItem('userEmail');
                if (userEmail) {
                    // Get user data from DynamoDB
                    const userData = await getUserByEmail(userEmail);
                    if (!userData) {
                        const queriedUser = await queryUserByEmail(userEmail);
                        if (queriedUser) {
                            setUserProfile(queriedUser);
                        }
                    } else {
                        setUserProfile(userData);
                    }
                }
            } catch (error) {
                console.error('Error fetching user profile:', error);
            }
        };

        fetchUserProfile();
    }, []);

    // Add copy function
    const handleCopyCode = () => {
        if (userProfile?.organizationCode) {
            navigator.clipboard.writeText(userProfile.organizationCode);
            setCopiedCode(true);
            setTimeout(() => setCopiedCode(false), 2000);
        }
    };

    // Add this function in the EventDashboard component
    const handleUpdateEvent = async (eventId: string, updates: {name?: string; coverImage?: string; date?: string}) => {
        try {
            const { bucketName } = await validateEnvVariables();
            const userEmail = localStorage.getItem('userEmail');
            if (!userEmail) {
                throw new Error('User not authenticated');
            }

            // Get existing event data
            const existingEvent = await getEventById(eventId);
            if (!existingEvent) {
                throw new Error('Event not found');
            }

            // If there's a new cover image, upload it to S3
            let coverImageUrl = updates.coverImage;
            if (updates.coverImage && updates.coverImage.startsWith('data:')) {
                const coverImageKey = `events/shared/${eventId}/cover.jpg`;
                
                // Convert base64 to buffer
                const base64Data = updates.coverImage.replace(/^data:image\/\w+;base64,/, '');
                const buffer = Buffer.from(base64Data, 'base64');

                // Upload directly to S3 using PutObjectCommand
                const uploadCommand = new PutObjectCommand({
                    Bucket: bucketName,
                    Key: coverImageKey,
                    Body: buffer,
                    ContentType: 'image/jpeg',
                    ACL: 'public-read' as ObjectCannedACL
                });

                await (await s3ClientPromise).send(uploadCommand);
                coverImageUrl = `https://${bucketName}.s3.amazonaws.com/${coverImageKey}`;
            }

            // Update event data
            const updatedEvent = {
                ...existingEvent,
                ...(updates.name && { name: updates.name }),
                ...(coverImageUrl && { coverImage: coverImageUrl }),
                ...(updates.date && { date: formatDateDDMMYY(updates.date) }),
                updatedAt: new Date().toISOString()
            };

            // Store updated event
            await storeEventData(updatedEvent);
            
            // Refresh events list
            await loadEvents();
            setEditMode(null);
            setEditedName('');
        } catch (error) {
            console.error('Error updating event:', error);
            alert('Failed to update event. Please try again.');
        }
    };


    // Add this function to handle direct file uploads to S3
    const uploadFileToS3 = async (file: File, key: string): Promise<string> => {
        try {
            const { bucketName } = await validateEnvVariables();
            // Convert File to arrayBuffer
            const fileBuffer = await file.arrayBuffer();
            
            // Upload directly to S3 using PutObjectCommand
            const uploadCommand = new PutObjectCommand({
                Bucket: bucketName,
                Key: key,
                Body: new Uint8Array(fileBuffer),
                ContentType: file.type,
                ACL: 'public-read' as ObjectCannedACL
            });

            await (await s3ClientPromise).send(uploadCommand);
            return `https://${bucketName}.s3.amazonaws.com/${key}`;
        } catch (error) {
            console.error('Error uploading to S3:', error);
            throw error;
        }
    };

    // Update the handleEditCoverImage function
    const handleEditCoverImage = async (e: React.ChangeEvent<HTMLInputElement>, eventId: string) => {
      const file = e.target.files?.[0];
      if (!file) return;

      // Helper to convert any image to JPEG with .jpg extension
      const convertToJpg = (file: File): Promise<File> => {
        return new Promise(async (resolve, reject) => {
          const fileName = file.name.toLowerCase();
          const isHeicHeif = fileName.endsWith('.heic') || fileName.endsWith('.heif') || file.type === 'image/heic' || file.type === 'image/heif';
          if (isHeicHeif) {
            try {
              const jpegBlob = await heic2any({
                blob: file,
                toType: 'image/jpeg',
                quality: 0.9,
              }) as Blob;
              const jpgFile = new File([jpegBlob], file.name.replace(/\.[^.]+$/, '.jpg'), { type: 'image/jpeg' });
              resolve(jpgFile);
              return;
            } catch (err) {
              reject(new Error('Failed to convert HEIC/HEIF image to JPG'));
              return;
            }
          }
          // For other image types, use canvas
          const reader = new FileReader();
          reader.onload = (event) => {
            const img = new window.Image();
            img.onload = () => {
              const canvas = document.createElement('canvas');
              canvas.width = img.width;
              canvas.height = img.height;
              const ctx = canvas.getContext('2d');
              if (!ctx) return reject(new Error('Failed to get canvas context'));
              ctx.drawImage(img, 0, 0);
              canvas.toBlob((blob) => {
                if (!blob) return reject(new Error('Failed to convert image to JPG'));
                const jpgFile = new File([blob], file.name.replace(/\.[^.]+$/, '.jpg'), { type: 'image/jpeg' });
                resolve(jpgFile);
              }, 'image/jpeg', 0.9);
            };
            img.onerror = reject;
            img.src = event.target?.result as string;
          };
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });
      };

      let jpgFile;
      try {
        jpgFile = await convertToJpg(file);
      } catch (err) {
        alert('Failed to convert image to JPG. Please try another image.');
        return;
      }

      // Upload the new cover image to S3 and update the event
      try {
        setIsLoading(true);
        const { bucketName } = await validateEnvVariables();
        const coverImageKey = `events/shared/${eventId}/cover.jpg`;
        const fileBuffer = await jpgFile.arrayBuffer();
        const uploadCommand = new PutObjectCommand({
          Bucket: bucketName,
          Key: coverImageKey,
          Body: new Uint8Array(fileBuffer),
          ContentType: 'image/jpeg',
          ACL: 'public-read' as ObjectCannedACL
        });
        await (await s3ClientPromise).send(uploadCommand);
        // Generate the S3 URL with timestamp to prevent caching
        const timestamp = Date.now();
        const coverImageUrl = `https://${bucketName}.s3.amazonaws.com/${coverImageKey}?t=${timestamp}`;
        // Update event with new cover image URL
        const existingEvent = await getEventById(eventId);
        if (!existingEvent) throw new Error('Event not found');
        const updatedEvent = {
          ...existingEvent,
          coverImage: coverImageUrl,
          updatedAt: new Date().toISOString()
        };
        // Store updated event
        const success = await storeEventData(updatedEvent);
        if (!success) throw new Error('Failed to update event data');
        // Update the local events state to reflect the new cover image immediately
        setEvents(prevEvents => prevEvents.map(ev => ev.id === eventId ? { ...ev, coverImage: coverImageUrl } : ev));
        setIsLoading(false);
        alert('Cover image updated successfully');
      } catch (error) {
        setIsLoading(false);
        console.error('Error updating cover image:', error);
        alert('Failed to update cover image. Please try again.');
      }
    };

    const handleDownloadQR = () => {
        if (qrRef.current) {
            const svg = qrRef.current;
            const svgData = new XMLSerializer().serializeToString(svg);
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            const img = new window.Image();
            
            img.onload = () => {
                canvas.width = img.width;
                canvas.height = img.height;
                ctx?.drawImage(img, 0, 0);
                const pngFile = canvas.toDataURL('image/png');
                const downloadLink = document.createElement('a');
                downloadLink.download = `organization-qr-${userProfile.organizationCode}.png`;
                downloadLink.href = pngFile;
                downloadLink.click();
            };
            
            img.src = 'data:image/svg+xml;base64,' + btoa(svgData);
        }
    };

    // Handle organization logo change and upload in one step
    const handleOrgLogoChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file || !userEmail) return;

        // Store logo as data URL in localStorage for watermarking
        const reader = new FileReader();
        reader.onload = function(ev) {
          if (ev.target && typeof ev.target.result === 'string') {
            localStorage.setItem('orgLogoDataUrl', ev.target.result);
          }
        };
        reader.readAsDataURL(file);

        // Validate file
        if (file.size > MAX_COVER_IMAGE_SIZE) {
            alert('File size too large. Please select a file smaller than 500MB.');
            return;
        }

        try {
            // Compress and upload the image
            const compressedBlob = await compressImage(file);
            const compressedFile = new File([compressedBlob], file.name, {
                type: file.type
            });

            // Upload to S3
            const s3Key = `users/${userEmail}/logo/${Date.now()}-${compressedFile.name}`;
            const logoUrl = await uploadFileToS3(compressedFile, s3Key);

            // Update user profile in DynamoDB
            const userData = await getUserByEmail(userEmail);
            if (userData) {
                await storeUserCredentials({
                    userId: userData.userId || userEmail,
                    email: userData.email || userEmail,
                    name: userData.name || '',
                    mobile: userData.mobile || '',
                    role: userData.role || 'organizer',
                    organizationName: userData.organizationName || '',
                    organizationCode: userData.organizationCode || '',
                    organizationLogo: logoUrl,
                    ...(userData.createdEvents ? { createdEvents: userData.createdEvents } : {})
                });

                // Update local state
                setUserProfile((prev: any) => ({
                    ...prev,
                    organizationLogo: logoUrl ? `${logoUrl}?t=${Date.now()}` : undefined
                }));

                // Success - logo updated
            }
        } catch (error) {
            console.error('Error uploading organization logo:', error);
            // Handle error state
            alert('Failed to upload organization logo. Please try again.');
        } finally {
            // Reset file input to allow selecting the same file again
            e.target.value = '';
            setIsUploadingOrgLogo(false);
        }
    };

    // Handle logo click to open file dialog
    const handleLogoClick = () => {
        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = 'image/*';
        fileInput.onchange = (e: any) => handleOrgLogoChange(e);
        fileInput.click();
    };

    // Organization name editing functions
    const handleOrgNameEdit = () => {
        setIsEditingOrgName(true);
        setEditedOrgName(userProfile?.organizationName || '');
    };

    const handleOrgNameUpdate = async () => {
        if (!editedOrgName.trim() || !userEmail || !userProfile?.organizationCode) return;

        setIsUpdatingOrgName(true);
        try {
            // Update user profile in DynamoDB
            const userData = await getUserByEmail(userEmail);
            if (userData) {
                await storeUserCredentials({
                    userId: userEmail,
                    email: userEmail,
                    name: userData.name || '',
                    mobile: userData.mobile || '',
                    role: userData.role || 'organizer',
                    organizationName: editedOrgName.trim(),
                    organizationCode: userData.organizationCode,
                    organizationLogo: userData.organizationLogo
                });

                // Update organization name across all events
                await updateOrganizationNameAcrossEvents(userProfile.organizationCode, editedOrgName.trim());

                // Update local state
                setUserProfile((prev: any) => ({
                    ...prev,
                    organizationName: editedOrgName.trim()
                }));

                // Clear edit state
                setIsEditingOrgName(false);
                setEditedOrgName('');
            }
        } catch (error) {
            console.error('Error updating organization name:', error);
            alert('Failed to update organization name. Please try again.');
        } finally {
            setIsUpdatingOrgName(false);
        }
    };

    const cancelOrgNameEdit = () => {
        setIsEditingOrgName(false);
        setEditedOrgName('');
    };

    // Add state and outside click handler for mobile sort dropdown
    const [showMobileSortDropdown, setShowMobileSortDropdown] = useState(false);
    useEffect(() => {
      if (!showMobileSortDropdown) return;
      const handleClick = (e: MouseEvent) => {
        const target = e.target as HTMLElement;
        if (!target.closest('.mobile-sort-popover') && !target.closest('.mobile-sort-filter-btn')) {
          setShowMobileSortDropdown(false);
        }
      };
      document.addEventListener('mousedown', handleClick);
      return () => document.removeEventListener('mousedown', handleClick);
    }, [showMobileSortDropdown]);



    useEffect(() => {
      if (!userProfile?.organizationCode) {
        setStats(prev => ({ ...prev, attendeeCount: 0 }));
        return;
      }
      const fetchAttendeeCount = async () => {
        try {
          const { docClientPromise, ATTENDEE_ORG_TABLE } = await import('../config/dynamodb');
          const { ScanCommand } = await import('@aws-sdk/lib-dynamodb');
          const ddbDocClient = await docClientPromise;
          const command = new ScanCommand({
            TableName: ATTENDEE_ORG_TABLE,
            FilterExpression: 'organizationCode = :orgCode',
            ExpressionAttributeValues: {
              ':orgCode': userProfile.organizationCode
            }
          });
          const response = await ddbDocClient.send(command);
          const userIds = response.Items ? response.Items.map((item: any) => item.userId) : [];
          const uniqueUserIds = Array.from(new Set(userIds));
          setStats(prev => ({ ...prev, attendeeCount: uniqueUserIds.length }));
        } catch (error) {
          console.error('Error fetching attendee count:', error);
          setStats(prev => ({ ...prev, attendeeCount: 0 }));
        }
      };
      fetchAttendeeCount();
    }, [userProfile?.organizationCode]);

    return (
        <div className={`relative bg-blue-45 flex flex-col pt-16 sm:pt-16 ${events.length === 0 ? 'h-[calc(100vh-70px)]' : 'min-h-screen'}`}>
            <div className="relative z-10 container mx-auto px-4 py-4 sm:py-6 flex-grow">
                {/* Mobile View Header */}
                <div className="sm:hidden space-y-4 mb-4">
                    <h1 className="text-2xl font-bold text-blue-900">Event Dashboard</h1>
                    <div className="flex gap-2">
                        {userProfile?.organizationCode && (
                            <div className="flex-1 bg-gradient-to-r from-blue-50 to-blue-100 border border-blue-200 shadow-sm px-2 py-2 rounded-lg">
                                <span className="text-xs text-gray-600 font-medium block">Org Code</span>
                                <div className="flex items-center justify-between">
                                    <span className="font-mono text-sm font-semibold text-blue-700">{userProfile.organizationCode}</span>
                                    <button
                                        onClick={handleCopyCode}
                                        className="text-blue-600 hover:text-blue-800 transition-colors p-1 hover:bg-blue-50 rounded-full"
                                    >
                                        {copiedCode ? (
                                            <CheckCircle className="h-4 w-4 text-blue-600" />
                                        ) : (
                                            <Copy className="h-4 w-4" />
                                        )}
                                    </button>
                                </div>
                            </div>
                        )}
                        <button
                            onClick={handleOpenCreateModal}
                            className="flex-1 flex items-center justify-center bg-gradient-to-r from-blue-600 to-blue-700 text-white py-2 px-3 rounded-lg hover:from-blue-700 hover:to-blue-800 transition-all duration-200 text-sm font-semibold shadow-md"
                        >
                            <Plus className="w-4 h-4 mr-1" />
                            Create New Event
                        </button>
                    </div>
                </div>

                {/* Desktop View Header */}
                <div className="hidden sm:flex mb-6 flex-row justify-between items-center">
                    <h1 className="text-3xl font-bold text-blue-900">Event Dashboard</h1>
                    <div className="flex items-center gap-3">
                        {userProfile?.organizationCode && (
                            <div className="flex items-center bg-gradient-to-r from-blue-50 to-blue-100 border border-blue-200 shadow-sm px-4 py-2 rounded-lg hover:shadow-md transition-shadow duration-200">
                                <div className="flex flex-col">
                                    <span className="text-xs text-gray-600 font-medium">Organization Code</span>
                                    <div className="flex items-center gap-2">
                                        <span className="font-mono text-sm font-semibold text-blue-700">{userProfile.organizationCode}</span>
                                        <button
                                            onClick={handleCopyCode}
                                            className="text-blue-600 hover:text-blue-800 transition-colors group relative"
                                        >
                                            {copiedCode ? (
                                                <CheckCircle className="h-4 w-4 text-blue-600" />
                                            ) : (
                                                <Copy className="h-4 w-4 group-hover:scale-110 transition-transform" />
                                            )}
                                            <span className="absolute -top-8 left-1/2 transform -translate-x-1/2 bg-gray-800 text-white px-2 py-1 text-xs rounded opacity-0 group-hover:opacity-100 transition-opacity">
                                                {copiedCode ? "Copied!" : "Copy code"}
                                            </span>
                                        </button>
                                    </div>
                                </div>
                            </div>
                        )}
                        <button
                            onClick={handleOpenCreateModal}
                            className="flex items-center justify-center bg-gradient-to-r from-blue-600 to-blue-700 text-white py-2 px-4 rounded-lg hover:from-blue-700 hover:to-blue-800 transition-all duration-200 text-sm font-semibold shadow-md hover:shadow-lg"
                        >
                            <Plus className="w-4 h-4 mr-2" />
                            Create New Event
                        </button>
                    </div>
                </div>

                <div className="mb-4 px-1">
                  <div className="flex flex-col sm:flex-row gap-2 md:gap-3">
                    {/* Total Events Card */}
                    <div 
                      onClick={() => setShowAllEvents(!showAllEvents)} 
                      className={`cursor-pointer transform hover:scale-105 transition-transform duration-200 w-full sm:w-1/3`}
                    >
                      <StatsCard
                        icon={<Image className="w-4 h-4 sm:w-5 sm:h-5 text-blue-900" />}
                        title="Total Events"
                        count={stats.eventCount}
                        bgColor="bg-gradient-to-br from-blue-100 to-blue-200"
                        titleColor="text-blue-900"
                        className="h-full"
                      />
                    </div>

                    {/* Total Photos Card */}
                    <div className={`transform hover:scale-105 transition-transform duration-200 w-full sm:w-1/3`}>
                      <StatsCard
                        icon={<Camera className="w-4 h-4 sm:w-5 sm:h-5 text-blue-900" />}
                        title="Total Photos"
                        count={stats.photoCount}
                        bgColor="bg-gradient-to-br from-blue-200 to-blue-300"
                        titleColor="text-blue-900"
                        className="h-full"
                      />
                    </div>

                    {/* Total Videos Card */}
                    <div className={`transform hover:scale-105 transition-transform duration-200 w-full sm:w-1/3`}>
                      <StatsCard
                        icon={<Video className="w-4 h-4 sm:w-5 sm:h-5 text-blue-900" />}
                        title="Total Videos"
                        count={stats.videoCount}
                        bgColor="bg-gradient-to-br from-blue-300 to-blue-400"
                        titleColor="text-blue-900"
                        className="h-full"
                      />
                    </div>

                    {/* Organization Info Card - Only show if organization exists, responsive */}
                  {userProfile?.organizationName && (
                      <div className="w-full sm:w-1/3 mt-2 sm:mt-0">
                      <div className="h-full p-3 sm:p-4 bg-gradient-to-br from-blue-50 to-blue-100 rounded-lg shadow-md flex items-center">
                        <div className="relative flex-shrink-0">
                          <div 
                            className={`relative h-10 w-10 sm:h-12 sm:w-12 rounded-full overflow-hidden border-2 ${isUploadingOrgLogo ? 'border-blue-400' : 'border-blue-200'} shadow-md group cursor-pointer transition-all duration-200 hover:border-blue-400`}
                            onClick={!isUploadingOrgLogo ? handleLogoClick : undefined}
                            title={isUploadingOrgLogo ? 'Uploading...' : 'Change organization logo'}
                          >
                            {isUploadingOrgLogo ? (
                              <div className="h-full w-full bg-blue-50 flex items-center justify-center">
                                <RefreshCw className="w-4 h-4 sm:w-5 sm:h-5 text-blue-400 animate-spin" />
                              </div>
                            ) : userProfile?.organizationLogo ? (
                              <img 
                                src={userProfile.organizationLogo || '/pixigologo.svg'} 
                                alt="Organization Logo" 
                                className="h-full w-full object-cover group-hover:opacity-90 transition-opacity"
                              />
                            ) : (
                              <div className="h-full w-full bg-blue-100 flex items-center justify-center group-hover:bg-blue-200 transition-colors">
                                <Camera className="w-4 h-4 sm:w-5 h-5 text-blue-500" />
                              </div>
                            )}
                            <div className="absolute inset-0 bg-black bg-opacity-0 group-hover:bg-opacity-30 flex items-center justify-center transition-all duration-200 opacity-0 group-hover:opacity-100">
                              <Camera className="w-3 h-3 sm:w-4 sm:h-4 text-white" />
                            </div>
                          </div>
                          <input
                            type="file"
                            className="hidden"
                            accept="image/*"
                            onChange={handleOrgLogoChange}
                            disabled={isUploadingOrgLogo}
                            id="org-logo-upload"
                          />
                        </div>
                        <div className="ml-2 sm:ml-3 overflow-hidden flex-1">
                          <span className="text-xs text-gray-600 font-medium truncate">Organization</span>
                          {isEditingOrgName ? (
                            <div className="flex items-center gap-2 w-full">
                              <input
                                type="text"
                                value={editedOrgName}
                                onChange={(e) => setEditedOrgName(e.target.value)}
                                className="text-xs sm:text-sm font-semibold text-blue-900 bg-white border border-blue-300 rounded px-1 sm:px-2 py-0.5 sm:py-1 focus:outline-none focus:border-blue-500 flex-1"
                                autoFocus
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') {
                                    handleOrgNameUpdate();
                                  } else if (e.key === 'Escape') {
                                    cancelOrgNameEdit();
                                  }
                                }}
                              />
                            </div>
                          ) : (
                            <div className="flex items-center justify-between">
                                <div className="flex flex-col">
                                  <h2 className="text-xs sm:text-sm font-semibold text-blue-900 truncate">{userProfile.organizationName}</h2>
                                  <div className="text-xs text-blue-700 mt-0.5 sm:mt-1 font-semibold">Members Joined: {stats.attendeeCount}</div>
                                </div>
                              <button
                                onClick={handleOrgNameEdit}
                                className="p-1 text-gray-500 hover:text-blue-600 rounded-full hover:bg-blue-50 ml-1"
                                title="Edit organization name"
                              >
                                <Edit className="w-3 h-3" />
                              </button>
                            </div>
                          )}
                        </div>
                        {isEditingOrgName ? (
                          <div className="ml-2 flex items-center gap-1">
                            <button
                              onClick={handleOrgNameUpdate}
                              disabled={!editedOrgName.trim() || isUpdatingOrgName}
                                                              className="p-1 sm:p-1.5 bg-blue-500 text-white rounded-full hover:bg-blue-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                              title="Save Name"
                            >
                              {isUpdatingOrgName ? (
                                <RefreshCw className="w-3 h-3 animate-spin" />
                              ) : (
                                <CheckCircle className="w-3 h-3" />
                              )}
                            </button>
                            <button
                              onClick={cancelOrgNameEdit}
                              disabled={isUpdatingOrgName}
                              className="p-1 sm:p-1.5 bg-red-500 text-white rounded-full hover:bg-red-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                              title="Cancel"
                            >
                              <X className="w-3 h-3" />
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setShowQRCode(true);
                            }}
                            className="ml-auto p-1.5 sm:p-2 text-blue-600 hover:bg-blue-100 rounded-full transition-colors"
                            title="Show QR Code"
                          >
                            <QrCode className="w-3 h-3 sm:w-4 sm:h-4" />
                          </button>
                        )}
                      </div>
                    </div>
                  )}

                    {/* Organization Info Card - Only show if NO organization exists */}
                  {!userProfile?.organizationName && (
                      <div className="w-full sm:w-1/3 mt-2 sm:mt-0">
                      <div className="h-full p-3 sm:p-4 bg-gradient-to-br from-blue-50 to-blue-100 rounded-lg shadow-md flex items-center">
                        <div className="relative flex-shrink-0">
                          <div className="h-10 w-10 sm:h-12 sm:w-12 rounded-full bg-blue-100 flex items-center justify-center">
                            <Users className="w-4 h-4 sm:w-5 sm:h-5 text-blue-500" />
                          </div>
                        </div>
                        <div className="ml-2 sm:ml-3 overflow-hidden flex-1">
                          <span className="text-xs text-gray-600 font-medium truncate">No Organization</span>
                          <div className="text-xs sm:text-sm font-semibold text-blue-900 truncate">Create one to collaborate</div>
                        </div>
                      </div>
                    </div>
                  )}
                    </div>
                  {/* Organization Info Card - Only show if organization exists, only in mobile */}
                    {userProfile?.organizationName && (
                    <div className="block md:hidden mt-2 w-full">
                      <div className="h-full p-4 bg-gradient-to-br from-blue-50 to-blue-100 rounded-lg shadow-md flex items-center">
                        <div className="relative flex-shrink-0">
                          <div 
                            className={`relative h-12 w-12 rounded-full overflow-hidden border-2 ${isUploadingOrgLogo ? 'border-blue-400' : 'border-blue-200'} shadow-md group cursor-pointer transition-all duration-200 hover:border-blue-400`}
                            onClick={!isUploadingOrgLogo ? handleLogoClick : undefined}
                            title={isUploadingOrgLogo ? 'Uploading...' : 'Change organization logo'}
                          >
                            {isUploadingOrgLogo ? (
                              <div className="h-full w-full bg-blue-50 flex items-center justify-center">
                                <RefreshCw className="w-5 h-5 text-blue-400 animate-spin" />
                              </div>
                            ) : userProfile?.organizationLogo ? (
                              <img 
                                src={userProfile.organizationLogo || '/pixigologo.svg'} 
                                alt="Organization Logo" 
                                className="h-full w-full object-cover group-hover:opacity-90 transition-opacity"
                              />
                            ) : (
                              <div className="h-full w-full bg-blue-100 flex items-center justify-center group-hover:bg-blue-200 transition-colors">
                                <Camera className="w-5 h-5 text-blue-500" />
                              </div>
                            )}
                            <div className="absolute inset-0 bg-black bg-opacity-0 group-hover:bg-opacity-30 flex items-center justify-center transition-all duration-200 opacity-0 group-hover:opacity-100">
                              <Camera className="w-4 h-4 text-white" />
                            </div>
                          </div>
                          <input
                            type="file"
                            className="hidden"
                            accept="image/*"
                            onChange={handleOrgLogoChange}
                            disabled={isUploadingOrgLogo}
                            id="org-logo-upload"
                          />
                        </div>
                        <div className="ml-3 overflow-hidden flex-1">
                          <span className="text-xs text-gray-600 font-medium truncate">Organization</span>
                          {isEditingOrgName ? (
                            <div className="flex items-center gap-2 w-full">
                              <input
                                type="text"
                                value={editedOrgName}
                                onChange={(e) => setEditedOrgName(e.target.value)}
                                className="text-sm font-semibold text-blue-900 bg-white border border-blue-300 rounded px-2 py-1 focus:outline-none focus:border-blue-500 flex-1"
                                autoFocus
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') {
                                    handleOrgNameUpdate();
                                  } else if (e.key === 'Escape') {
                                    cancelOrgNameEdit();
                                  }
                                }}
                              />
                            </div>
                          ) : (
                            <div className="flex items-center justify-between">
                              <div className="flex flex-col">
                                <h2 className="text-sm font-semibold text-blue-900 truncate">{userProfile.organizationName}</h2>
                                <div className="text-xs text-blue-700 mt-1 font-semibold">Members Joined: {stats.attendeeCount}</div>
                              </div>
                              <button
                                onClick={handleOrgNameEdit}
                                className="p-1 text-gray-500 hover:text-blue-600 rounded-full hover:bg-blue-50 ml-1"
                                title="Edit organization name"
                              >
                                <Edit className="w-3 h-3" />
                              </button>
                            </div>
                          )}
                        </div>
                        {isEditingOrgName ? (
                          <div className="ml-2 flex items-center gap-1">
                            <button
                              onClick={handleOrgNameUpdate}
                              disabled={!editedOrgName.trim() || isUpdatingOrgName}
                                                              className="p-1.5 bg-blue-500 text-white rounded-full hover:bg-blue-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                              title="Save Name"
                            >
                              {isUpdatingOrgName ? (
                                <RefreshCw className="w-3 h-3 animate-spin" />
                              ) : (
                                <CheckCircle className="w-3 h-3" />
                              )}
                            </button>
                            <button
                              onClick={cancelOrgNameEdit}
                              disabled={isUpdatingOrgName}
                              className="p-1.5 bg-red-500 text-white rounded-full hover:bg-red-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                              title="Cancel"
                            >
                              <X className="w-3 h-3" />
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setShowQRCode(true);
                            }}
                            className="ml-auto p-2 text-blue-600 hover:bg-blue-100 rounded-full transition-colors"
                            title="Show QR Code"
                          >
                            <QrCode className="w-4 h-4" />
                          </button>
                        )}
                      </div>
                      </div>
                    )}
                </div>

                {/* QR Code Modal */}
                {showQRCode && (
                    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
                        <div className="bg-white rounded-xl shadow-2xl w-full max-w-md mx-4 overflow-hidden">
                            {/* Header */}
                            <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
                                <h3 className="text-xl font-bold text-gray-900">Organization QR Code</h3>
                                <button
                                    onClick={() => setShowQRCode(false)}
                                    className="text-gray-400 hover:text-gray-600 transition-colors p-1 -mr-2"
                                    aria-label="Close modal"
                                >
                                    <X className="w-5 h-5" />
                                </button>
                            </div>
                            
                            {/* Content */}
                            <div className="p-6">
                                <div className="flex flex-col items-center space-y-6">
                                    {/* QR Code */}
                                    <div className="p-4 bg-white rounded-lg border border-gray-200">
                                        <QRCodeSVG
                                            ref={qrRef}
                                            value={`${window.location.origin}/my-organizations?code=${userProfile.organizationCode}`}
                                            size={200}
                                            level="H"
                                            includeMargin
                                        />
                                    </div>

                                    {/* Organization Code */}
                                    <div className="text-center">
                                        <p className="text-sm font-medium text-gray-500 mb-1">Organization Code</p>
                                        <div className="text-2xl font-bold text-blue-600 font-mono tracking-wider">
                                            {userProfile.organizationCode}
                                        </div>
                                    </div>

                                    {/* Shareable Link */}
                                    <div className="w-full">
                                        <label htmlFor="share-link" className="block text-sm font-medium text-gray-700 mb-1">
                                            Shareable Link
                                        </label>
                                        <div className="flex flex-col sm:flex-row gap-2 w-full">
                                            <div className="relative flex-grow">
                                                <input
                                                    id="share-link"
                                                    type="text"
                                                    readOnly
                                                    value={`${window.location.origin}/my-organizations?code=${userProfile.organizationCode}`}
                                                    className="w-full px-4 py-2 pr-10 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                                                    onClick={(e) => (e.target as HTMLInputElement).select()}
                                                />
                                                <button
                                                    type="button"
                                                    onClick={() => {
                                                        navigator.clipboard.writeText(
                                                            `${window.location.origin}/my-organizations?code=${userProfile.organizationCode}`
                                                        );
                                                        setCopiedCode(true);
                                                        setTimeout(() => setCopiedCode(false), 2000);
                                                    }}
                                                    className="absolute inset-y-0 right-0 px-3 flex items-center text-gray-500 hover:text-blue-600 transition-colors"
                                                    title="Copy to clipboard"
                                                >
                                                    {copiedCode ? (
                                                        <CheckCircle className="w-4 h-4 text-blue-500" />
                                                    ) : (
                                                        <Copy className="w-4 h-4" />
                                                    )}
                                                </button>
                                            </div>
                                            <button
                                                type="button"
                                                onClick={handleDownloadQR}
                                                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg flex items-center justify-center gap-2 transition-colors"
                                            >
                                                <Download className="w-4 h-4" />
                                                <span className="hidden sm:inline">Download</span>
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                )}
                

                {/* Create Event Modal */}
                {isModalOpen && (
                    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
                        <div className="bg-white rounded-lg shadow-md border border-blue-400 mx-auto w-full max-w-xs sm:max-w-sm overflow-auto max-h-[80vh]">
                            <div className="flex justify-between items-center p-3 border-b border-gray-200">
                                <h2 className="text-base font-bold text-blue-700">Create New Event</h2>
                                <button
                                    onClick={() => {
                                        setIsModalOpen(false);
                                        props.setShowNavbar(true);
                                    }}
                                    className="text-black hover:text-gray-700"
                                >
                                    <X className="w-4 h-4" />
                                </button>
                            </div>
                            <form onSubmit={handleCreateEvent} className="p-3 space-y-2">
                                {coverImagePreview && (
                                    <div className="relative w-full h-24 mb-2">
                                        <img
                                            src={coverImagePreview}
                                            alt="Cover preview"
                                            className="w-full h-full object-cover rounded-lg"
                                        />
                                        <button
                                            type="button"
                                            onClick={() => {
                                                setCoverImagePreview(null);
                                                setNewEvent(prev => ({ ...prev, coverImage: undefined }));
                                            }}
                                            className="absolute top-1 right-1 p-1 bg-blue-500 text-white rounded-full hover:bg-blue-600"
                                        >
                                            <X className="w-3 h-3" />
                                        </button>
                                    </div>
                                )}
                                
                                <div>
                                    <label className="block text-blue-700 text-xs mb-1" htmlFor="eventName">
                                        Event Name <span className="text-red-500">*</span>
                                    </label>
                                    <input
                                        type="text"
                                        id="eventName"
                                        value={newEvent.name}
                                        onChange={(e) => setNewEvent({ ...newEvent, name: e.target.value })}
                                        className="w-full border border-blue-300 rounded-lg px-2 py-1 text-xs focus:outline-none focus:border-primary"
                                        required
                                    />
                                </div>
                                <div>
                                    <label className="block text-blue-700 text-xs mb-1" htmlFor="eventDate">
                                        Event Date <span className="text-red-500">*</span>
                                    </label>
                                    <input
                                        type="date"
                                        id="eventDate"
                                        value={newEvent.date}
                                        onChange={(e) => setNewEvent({ ...newEvent, date: e.target.value })}
                                        className="w-full border border-blue-300 rounded-lg px-2 py-1 text-xs focus:outline-none focus:border-primary"
                                        required
                                    />
                                </div>
                                <div className="mb-2">
                                    <label className="block text-blue-900 text-xs mb-1" htmlFor="coverImage">
                                        Cover Image <span className="text-red-500">*</span>
                                    </label>
                                    <input
                                        type="file"
                                        id="coverImage"
                                        accept="image/*"
                                        onChange={handleCoverImageChange}
                                        className="w-full text-xs text-blue-900 file:mr-2 file:py-1 file:px-2 file:rounded-full file:border-0 file:text-xs file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100"
                                        required
                                    />
                                </div>
                                <button
                                    type="submit"
                                    disabled={isLoading}
                                    className="w-full bg-blue-300 text-black py-1.5 px-3 rounded-lg hover:bg-secondary transition-colors duration-200 disabled:opacity-50 mt-3 text-xs"
                                >
                                    {isLoading ? 'Creating Event...' : 'Create Event'}
                                </button>
                            </form>
                        </div>
                    </div>
                )}

                <div className="text-center mb-8"></div>

                {/* Delete Confirmation Modal */}
                {deleteConfirmation.isOpen && (
                    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
                        <div className="bg-white rounded-lg p-6 max-w-sm w-full">
                            <h3 className="text-xl font-bold text-gray-800 mb-4">Confirm Delete</h3>
                            <p className="text-gray-600 mb-6">Are you sure you want to delete this event? This action cannot be undone.</p>
                            <div className="flex justify-end space-x-4">
                                <button
                                    onClick={() => setDeleteConfirmation({isOpen: false, eventId: '', userEmail: ''})}
                                    className="px-4 py-2 text-gray-600 hover:text-gray-800 transition-colors duration-200"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={handleConfirmDelete}
                                    className="bg-blue-500 text-white px-4 py-2 rounded-lg hover:bg-blue-600 transition-colors duration-200"
                                >
                                    Delete
                                </button>
                            </div>
                        </div>
                    </div>
                )}

                {showAllEvents && events.length > 0 && (
                    <div className="mt-4 sm:mt-6">
                        <div className="flex flex-row justify-between items-center mb-3 sm:mb-4">
                            <h2 className="text-xl font-bold text-blue-900">All Events</h2>
                            <div className="hidden sm:flex items-center gap-3">
                                {/* Search Input */}
                                <div className="relative">
                                    <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                                        <Search className="h-4 w-4 text-gray-400" />
                                    </div>
                                    <input
                                        type="text"
                                        placeholder="Search events..."
                                        value={searchQuery}
                                        onChange={(e) => setSearchQuery(e.target.value)}
                                        className="w-48 pl-10 pr-3 py-1.5 text-sm border border-gray-300 rounded-md bg-white shadow-sm focus:ring-blue-500 focus:border-blue-500"
                                    />
                                </div>
                                {/* Sort dropdown (desktop) */}
                                <div className="w-40">
                                    <select
                                        className="w-full border border-gray-300 rounded-md px-3 py-1.5 text-sm bg-white shadow-sm focus:ring-blue-500 focus:border-blue-500"
                                        value={sortOption}
                                        onChange={(e) => setSortOption(e.target.value as 'name' | 'name-desc' | 'date' | 'date-desc')}
                                    >
                                        <option value="date">Latest First</option>
                                        <option value="date-desc">Oldest First</option>
                                        <option value="name">Sort by Name (A-Z)</option>
                                        <option value="name-desc">Sort by Name (Z-A)</option>
                                    </select>
                                </div>
                            </div>
                        </div>
                        {/* Mobile Search Input and Sort Dropdown */}
                        <div className="sm:hidden mb-4 flex flex-col gap-2 relative">
                            <div className="flex items-center gap-2 relative">
                                <div className="relative flex-1">
                                    <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                                        <Search className="h-4 w-4 text-gray-400" />
                                    </div>
                                    <input
                                        type="text"
                                        placeholder="Search events..."
                                        value={searchQuery}
                                        onChange={(e) => setSearchQuery(e.target.value)}
                                        className="w-full pl-10 pr-3 py-2 text-sm border border-gray-300 rounded-md bg-white shadow-sm focus:ring-blue-500 focus:border-blue-500"
                                    />
                                </div>
                                {/* Filter icon for sort options */}
                                <button
                                    type="button"
                                    className="p-2 rounded-full bg-white border border-gray-300 hover:bg-blue-50 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-opacity-50 flex-shrink-0 mobile-sort-filter-btn"
                                    onClick={() => setShowMobileSortDropdown(v => !v)}
                                    aria-label="Show sort options"
                                >
                                    <Filter className="h-5 w-5 text-blue-600" />
                                </button>
                                {/* Sort dropdown popover */}
                                {showMobileSortDropdown && (
                                    <div
                                        className="absolute top-12 right-0 z-50 w-44 bg-white border border-gray-200 rounded-lg shadow-lg py-2 animate-fadeIn mobile-sort-popover"
                                        style={{ maxWidth: 'calc(100vw - 2rem)' }}
                                    >
                                        <button
                                            className={`w-full flex items-center text-left px-4 py-2 text-sm hover:bg-blue-50 ${sortOption === 'date' ? 'font-semibold text-blue-700' : 'text-gray-700'}`}
                                            onClick={() => { setSortOption('date'); setShowMobileSortDropdown(false); }}
                                        >
                                            {sortOption === 'date' && <Check className="w-4 h-4 mr-2 text-blue-600" />}Latest First
                                        </button>
                                        <button
                                            className={`w-full flex items-center text-left px-4 py-2 text-sm hover:bg-blue-50 ${sortOption === 'date-desc' ? 'font-semibold text-blue-700' : 'text-gray-700'}`}
                                            onClick={() => { setSortOption('date-desc'); setShowMobileSortDropdown(false); }}
                                        >
                                            {sortOption === 'date-desc' && <Check className="w-4 h-4 mr-2 text-blue-600" />}Oldest First
                                        </button>
                                        <button
                                            className={`w-full flex items-center text-left px-4 py-2 text-sm hover:bg-blue-50 ${sortOption === 'name' ? 'font-semibold text-blue-700' : 'text-gray-700'}`}
                                            onClick={() => { setSortOption('name'); setShowMobileSortDropdown(false); }}
                                        >
                                            {sortOption === 'name' && <Check className="w-4 h-4 mr-2 text-blue-600" />}Sort by Name (A-Z)
                                        </button>
                                        <button
                                            className={`w-full flex items-center text-left px-4 py-2 text-sm hover:bg-blue-50 ${sortOption === 'name-desc' ? 'font-semibold text-blue-700' : 'text-gray-700'}`}
                                            onClick={() => { setSortOption('name-desc'); setShowMobileSortDropdown(false); }}
                                        >
                                            {sortOption === 'name-desc' && <Check className="w-4 h-4 mr-2 text-blue-600" />}Sort by Name (Z-A)
                                        </button>
                                    </div>
                                )}
                            </div>
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3 sm:gap-4">
                            {Array.isArray(events) && filteredEvents.map((event) => (
                                <div key={event.id} className="bg-gradient-to-br from-white to-blue-50 rounded-lg shadow-md border border-blue-200 overflow-hidden transform hover:scale-102 hover:shadow-lg transition-all duration-200">
                                    {event.coverImage ? (
                                        <div className="relative w-full h-32 sm:h-40 overflow-hidden">
                                            {/* Full blurred background to fill the entire container */}
                                            <div 
                                                className="absolute inset-0 bg-center bg-cover filter blur-md opacity-40 scale-110"
                                                style={{ backgroundImage: `url(${event.coverImage})` }}
                                            ></div>
                                            
                                            {/* Image container with consistent sizing */}
                                            <div className="absolute inset-0 flex items-center justify-center">
                                                <img 
                                                    src={event.coverImage}
                                                    alt={event.name} 
                                                    className="object-contain max-h-full max-w-full hover:scale-105 transition-transform duration-500"
                                                    style={{ 
                                                        maxHeight: '100%', 
                                                        maxWidth: '100%',
                                                        boxShadow: '0 0 20px rgba(0, 0, 0, 0.1)'
                                                    }}
                                                    onLoad={(e) => {
                                                        // Detect orientation on image load
                                                        const img = e.currentTarget;
                                                        const orientation = img.naturalWidth >= img.naturalHeight ? 'landscape' : 'portrait';
                                                        setImageOrientations(prev => ({
                                                            ...prev,
                                                            [event.id]: orientation
                                                        }));
                                                    }}
                                                />
                                            </div>
                                            
                                            <label className="absolute bottom-2 right-2 bg-blue-500 text-white p-1.5 rounded-full cursor-pointer hover:bg-blue-600 transition-colors z-10">
                                                <input
                                                    type="file"
                                                    className="hidden"
                                                    accept="image/*"
                                                    onChange={(e) => {
                                                        handleEditCoverImage(e, event.id);
                                                        e.target.value = ''; // Reset input
                                                    }}
                                                    disabled={isLoading}
                                                />
                                                {isLoading ? (
                                                    <RefreshCw className="w-4 h-4 animate-spin" />
                                                ) : (
                                                    <Camera className="w-4 h-4" />
                                                )}
                                            </label>
                                        </div>
                                    ) : (
                                        <div className="relative w-full h-32 sm:h-40 bg-gradient-to-br from-blue-50 to-blue-100 flex items-center justify-center">
                                            <label className="cursor-pointer flex items-center justify-center w-full h-full">
                                                <input
                                                    type="file"
                                                    className="hidden"
                                                    accept="image/*"
                                                    onChange={(e) => {
                                                        handleEditCoverImage(e, event.id);
                                                        e.target.value = ''; // Reset input
                                                    }}
                                                    disabled={isLoading}
                                                />
                                                {isLoading ? (
                                                    <RefreshCw className="w-6 h-6 text-blue-400 animate-spin" />
                                                ) : (
                                                    <Camera className="w-6 h-6 text-blue-400" />
                                                )}
                                            </label>
                                        </div>
                                    )}
                                    <div className="p-2 sm:p-2.5">
                                        {editMode?.eventId === event.id && editMode.type === 'name' ? (
                                            <form onSubmit={(e) => {
                                                e.preventDefault();
                                                handleUpdateEvent(event.id, { name: editedName });
                                            }}>
                                                <input
                                                    type="text"
                                                    value={editedName}
                                                    onChange={(e) => setEditedName(e.target.value)}
                                                    className="w-full px-2 py-1 text-sm border border-blue-300 rounded focus:outline-none focus:border-blue-500"
                                                    autoFocus
                                                    onBlur={() => setEditMode(null)}
                                                />
                                            </form>
                                        ) : (
                                            <div className="flex items-center justify-between">
                                                <h3 className="text-xs sm:text-sm font-semibold text-blue-900 mb-1 sm:mb-1.5 line-clamp-1">{event.name}</h3>
                                                <button
                                                    onClick={() => {
                                                        setEditMode({ eventId: event.id, type: 'name' });
                                                        setEditedName(event.name);
                                                    }}
                                                    className="p-1 text-gray-500 hover:text-blue-600 rounded-full hover:bg-blue-50"
                                                >
                                                    <Edit className="w-3 h-3" />
                                                </button>
                                            </div>
                                        )}
                                        <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-0 mb-1.5 bg-blue-50 rounded-lg p-2 sm:p-1">
                                            <div className="flex items-center">
                                                <span className="text-xs font-medium text-gray-600 mr-1">Code:</span>
                                                <span className="text-xs font-mono font-medium text-blue-700">{event.id}</span>
                                                <button 
                                                    onClick={() => handleCopyEventId(event.id)}
                                                    className="ml-1 text-blue-600 hover:text-blue-800 p-0.5 hover:bg-blue-100 rounded-full transition-colors group relative"
                                                    title="Copy event code"
                                                >
                                                    {copiedEventId === event.id ? (
                                                        <CheckCircle className="w-3 h-3 text-blue-600" />
                                                    ) : (
                                                        <Copy className="w-3 h-3" />
                                                    )}
                                                    <span className="absolute -top-8 left-1/2 transform -translate-x-1/2 bg-gray-800 text-white px-2 py-1 text-xs rounded opacity-0 group-hover:opacity-100 transition-opacity">
                                                        {copiedEventId === event.id ? "Copied!" : "Copy code"}
                                                    </span>
                                                </button>
                                            </div>
                                            <span className="flex items-center text-xs font-medium text-gray-600 sm:ml-auto">
                                                <Users className="w-3 h-3 mr-1" />
                                                {eventAttendeeCounts[event.id] || 0}
                                            </span>
                                        </div>
                                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 sm:gap-0 mb-1.5">
                                            {editMode?.eventId === event.id && editMode.type === 'date' ? (
                                                <div className="flex items-center gap-2">
                                                    <input
                                                        type="date"
                                                        value={editedDate}
                                                        onChange={(e) => setEditedDate(e.target.value)}
                                                        className="text-xs border border-blue-300 rounded px-1 py-0.5 focus:outline-none focus:border-blue-500"
                                                        autoFocus
                                                    />
                                                    <button
                                                        onClick={() => handleUpdateEvent(event.id, { date: editedDate })}
                                                        className="text-blue-600 hover:text-blue-700 p-0.5 hover:bg-blue-50 rounded-full"
                                                    >
                                                        <CheckCircle className="w-3 h-3" />
                                                    </button>
                                                    <button
                                                        onClick={() => setEditMode(null)}
                                                        className="text-red-600 hover:text-red-700 p-0.5 hover:bg-red-50 rounded-full"
                                                    >
                                                        <X className="w-3 h-3" />
                                                    </button>
                                                </div>
                                            ) : (
                                                <div className="flex items-center gap-1">
                                                    <p className="text-xs text-gray-600">
                                                        <span className="font-medium">Date:</span> {formatDateDDMMYY(event.date)}
                                                    </p>
                                                    <button
                                                        onClick={() => {
                                                            setEditMode({ eventId: event.id, type: 'date' });
                                                            // Format date as YYYY-MM-DD for date input
                                                            const date = new Date(event.date);
                                                            const formattedDate = date.toISOString().split('T')[0];
                                                            setEditedDate(formattedDate);
                                                        }}
                                                        className="p-0.5 text-gray-500 hover:text-blue-600 rounded-full hover:bg-blue-50"
                                                    >
                                                        <Edit className="w-3 h-3" />
                                                    </button>
                                                </div>
                                            )}
                                            <div className="flex flex-col sm:flex-row items-start sm:items-center gap-1 sm:gap-3 text-xs">
                                                <div className="flex items-center gap-1 text-blue-600">
                                                    <Image className="w-3 h-3" />
                                                    <span>{event.photoCount || 0} photos</span>
                                                </div>
                                                <div className="flex items-center gap-1 text-purple-600">
                                                    <Video className="w-3 h-3" />
                                                    <span>{event.videoCount || 0} videos</span>
                                                </div>
                                            </div>
                                        </div>
                                        {event.description && (
                                            <p className="text-xs text-gray-500 mb-2 line-clamp-2">{event.description}</p>
                                        )}
                                        <div className="flex flex-col sm:flex-row gap-2 sm:gap-1.5 sm:justify-end">
                                            <Link
                                                to={`/view-event/${event.id}`}
                                                className="bg-gradient-to-r from-blue-500 to-blue-600 text-white px-3 sm:px-4 py-1.5 sm:py-1 rounded-lg hover:from-blue-600 hover:to-blue-700 transition-all duration-200 text-xs font-medium shadow-sm hover:shadow-md text-center"
                                            >
                                                View
                                            </Link>
                                            <button
                                                onClick={() => handleDeleteClick(event.id, event.userEmail)}
                                                className="bg-white border border-gray-300 text-gray-700 px-3 sm:px-4 py-1.5 sm:py-1 rounded-lg hover:bg-red-500 hover:text-white hover:border-red-500 transition-all duration-200 flex items-center justify-center text-xs font-medium shadow-sm hover:shadow-md group"
                                            >
                                                <Trash2 className="w-3 h-3 mr-1 group-hover:text-white" />
                                                Delete
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                )}
            
            </div>
        </div>
    );
    
};

export default EventDashboard;