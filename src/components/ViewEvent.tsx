import React, { useState, useEffect, useCallback, useRef } from 'react';
import { ListObjectsV2Command, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { s3ClientPromise, validateEnvVariables } from '../config/aws';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Camera, X, ArrowLeft, Download, Upload as UploadIcon, Copy, UserPlus, Facebook, Instagram, Twitter, Youtube, ChevronLeft, ChevronRight, RotateCw, Share2, CheckCircle, Mail, MessageCircle, Linkedin } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { Link, useNavigate } from 'react-router-dom';
import { getEventById, updateEventData, convertToAppropriateUnit } from '../config/eventStorage';
import ProgressiveImage from './ProgressiveImage';

interface ViewEventProps {
  eventId: string;
  selectedEvent?: string;
  onEventSelect?: (eventId: string) => void;
}

interface EventImage {
  url: string;
  key: string;
}

interface EventVideo {
  url: string;
  key: string;
  thumbnailUrl: string;
  thumbnailKey: string;
  name: string;
  duration?: number;
  frameCount?: number;
}

interface FaceRecordWithImage {
  faceId: string;
  boundingBox?: { Left: number; Top: number; Width: number; Height: number };
  image: EventImage;
}

interface FaceGroups {
  [groupId: string]: FaceRecordWithImage[];
}

/**
 * A small helper component that displays one face as a 96×96 circular thumbnail,
 * zooming and centering on the face bounding box.
 */
const FaceThumbnail: React.FC<{
  faceRec: FaceRecordWithImage;
  onClick: () => void;
}> = ({ faceRec, onClick }) => {
  const { image, boundingBox } = faceRec;

  // We interpret boundingBox as fractions of the original image:
  // boundingBox.Left, boundingBox.Top, boundingBox.Width, boundingBox.Height are in [0..1].
  // We'll place an absolutely positioned <img> inside a 96×96 container.
  // Then use transform to scale & shift the face center to the middle.

  const containerSize = 96; // px
  const centerX = boundingBox ? boundingBox.Left + boundingBox.Width / 2 : 0.5;
  const centerY = boundingBox ? boundingBox.Top + boundingBox.Height / 2 : 0.5;
  // Scale so that the bounding box is at least the container size in both width & height.
  // If boundingBox.Width = 0.2, then scale ~ 1 / 0.2 = 5 => we clamp to some max to avoid extremes.
  let scale = boundingBox
    ? 1 / Math.min(boundingBox.Width, boundingBox.Height)
    : 1;
  scale = Math.max(1.2, Math.min(scale, 2)); // clamp scale between [1.2..3] for better face visibility

  // We'll shift the image so that the face center ends up at the container's center (48px, 48px).
  // The face center in the image's local coordinate space (before scaling) is at
  // (centerX * imageWidth, centerY * imageHeight).
  // Because we're using fractional bounding boxes, we treat the image as if it's 1×1, 
  // then scaled to 'scale', so the face center is at (centerX * scale, centerY * scale) in "image" space.
  // We want that point to appear at (0.5, 0.5) in the container, i.e. 50% 50% of the container.
  // We'll do a trick: set transform-origin to top-left (0,0), then use translateX/Y to push the center to 50% of container.

  // The translation in fraction-of-container is:
  //   xTranslate = 0.5*containerSize - (centerX * containerSize * scale)
  //   yTranslate = 0.5*containerSize - (centerY * containerSize * scale)
  // We'll just compute them in px for clarity.
  const xTranslate = 0.5 * containerSize - centerX * containerSize * scale;
  const yTranslate = 0.5 * containerSize - centerY * containerSize * scale;

  const thumbnailStyle: React.CSSProperties = {
    width: `${containerSize}px`,
    height: `${containerSize}px`,
    borderRadius: '9999px',
    overflow: 'hidden',
    position: 'relative',
    cursor: 'pointer'
  };

  const imgStyle: React.CSSProperties = {
    position: 'absolute',
    top: 0,
    left: 0,
    // We'll assume a base size of containerSize for the image. 
    // Because we only have fractions, this is approximate.
    width: `${containerSize}px`,
    height: 'auto',
    transform: `translate(${xTranslate}px, ${yTranslate}px) scale(${scale})`,
    transformOrigin: 'top left',
    // If the image is originally landscape, 'height: auto' might not fill the container vertically.
    // But objectFit won't apply because we have an absolutely positioned element.
    // This approach still tends to produce a better face crop than background methods if bounding boxes are correct.
  };

  return (
    <div style={thumbnailStyle} onClick={onClick}>
      <img src={image.url} alt="face" style={imgStyle} />
    </div>
  );
};

interface ShareMenuState {
  isOpen: boolean;
  imageUrl: string;
  position: {
    top: number;
    left: number;
  };
}

const ViewEvent: React.FC<ViewEventProps> = ({ eventId, selectedEvent, onEventSelect }) => {
  const navigate = useNavigate();
  const [images, setImages] = useState<EventImage[]>([]);
  const [videos, setVideos] = useState<EventVideo[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchingImages, setFetchingImages] = useState(false);
  const [selectedImage, setSelectedImage] = useState<EventImage | null>(null);
  const [selectedVideo, setSelectedVideo] = useState<EventVideo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [showCopySuccess, setShowCopySuccess] = useState(false);
  const [showQRModal, setShowQRModal] = useState(false);
  const [showAddAccessModal, setShowAddAccessModal] = useState(false);
  const [emailInput, setEmailInput] = useState('');
  const [emailAccessList, setEmailAccessList] = useState<string[]>([]);
  const [isEventCreator, setIsEventCreator] = useState(false);
  const [anyoneCanUpload, setAnyoneCanUpload] = useState(false);
  const [eventName, setEventName] = useState<string>('');
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedImages, setSelectedImages] = useState<Set<string>>(new Set());
  const [selectedVideos, setSelectedVideos] = useState<Set<string>>(new Set());
  const [showShareModal, setShowShareModal] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [imagesPerPage] = useState(20);
  const [totalImages, setTotalImages] = useState<EventImage[]>([]);
  const [hasMoreImages, setHasMoreImages] = useState(true);
  const [activeTab, setActiveTab] = useState<'photos' | 'videos'>('photos');

  // Add rotation state at the top of the component
  const [rotation, setRotation] = useState(0);
  // Add state at the top of the component
  const [showCopyEventId, setShowCopyEventId] = useState(false);
  const [showCopyUpload, setShowCopyUpload] = useState(false);
  const [showCopiedIndex, setShowCopiedIndex] = useState<string | null>(null);

  const qrCodeRef = useRef<SVGSVGElement>(null);
  const loadMoreRef = useRef<HTMLDivElement>(null);

  const [shareMenu, setShareMenu] = useState<ShareMenuState>({
    isOpen: false,
    imageUrl: '',
    position: { top: 0, left: 0 }
  });

  // Reset rotation when image changes or modal closes
  useEffect(() => {
    setRotation(0);
  }, [selectedImage]);

  // Toggle header and footer visibility when image is clicked
  const toggleHeaderFooter = (visible: boolean) => {
    const header = document.querySelector('header');
    const footer = document.querySelector('footer');
    
    if (header) {
      if (visible) {
        header.classList.remove('hidden');
      } else {
        header.classList.add('hidden');
      }
    }
    
    if (footer) {
      if (visible) {
        footer.classList.remove('hidden');
      } else {
        footer.classList.add('hidden');
      }
    }
  };

  useEffect(() => {
    const path = window.location.pathname;
    if (path.includes('upload_selfie') || path.includes('upload-selfie')) {
      const userEmail = localStorage.getItem('userEmail');
      if (!userEmail) {
        setError('Authentication required. Please log in.');
        return;
      }
      if (path !== `/upload-selfie/${eventId}`) {
        navigate(`/upload-selfie/${eventId}`, { state: { eventId }, replace: true });
        return;
      }
    }
  }, [eventId, navigate]);

  useEffect(() => {
    setCurrentPage(1);
    setImages([]);
    setVideos([]);
    setTotalImages([]);
    setHasMoreImages(true);
    fetchEventImages(1, false);
    fetchEventVideos();
    if (selectedEvent && onEventSelect) {
      onEventSelect(selectedEvent);
    }
  }, [eventId, selectedEvent]);

  // Check if we should show an error after both images and videos are fetched
  useEffect(() => {
    if (!loading && images.length === 0 && videos.length === 0) {
      setError('No images or videos found for this event.');
    } else if (images.length > 0 || videos.length > 0) {
      setError(null);
      // If no images but there are videos, default to videos tab
      if (images.length === 0 && videos.length > 0 && activeTab === 'photos') {
        setActiveTab('videos');
      }
    }
  }, [loading, images.length, videos.length, activeTab]);

  // Add a function to refresh videos that can be called externally
  const refreshVideos = useCallback(() => {
    console.log('[DEBUG] Refreshing videos...');
    fetchEventVideos();
  }, []);

  // Function to test if a video URL is accessible
  const testVideoUrl = async (url: string): Promise<boolean> => {
    try {
      const response = await fetch(url, { method: 'HEAD' });
      return response.ok;
    } catch (error) {
      console.error(`[DEBUG] Error testing video URL ${url}:`, error);
      return false;
    }
  };

  // Expose refresh function to parent components if needed
  useEffect(() => {
    // Extend window object to include our refresh function
    (window as any).refreshEventVideos = refreshVideos;
  }, [refreshVideos]);

  // Listen for video upload completion events
  useEffect(() => {
    const handleVideoUploadComplete = (event: CustomEvent) => {
      const { uploadedEventId } = event.detail;
      if (uploadedEventId === eventId) {
        console.log('[DEBUG] Video upload completed for this event, refreshing videos...');
        // Add a small delay to ensure S3 is updated
        setTimeout(() => {
          refreshVideos();
          // Automatically switch to videos tab to show the newly uploaded videos
          setActiveTab('videos');
        }, 2000);
      }
    };

    // Listen for custom event
    window.addEventListener('videoUploadComplete', handleVideoUploadComplete as EventListener);
    
    // Also check localStorage periodically for upload completion
    const checkUploadCompletion = () => {
      const uploadCompleteKey = `videoUploadComplete_${eventId}`;
      const uploadComplete = localStorage.getItem(uploadCompleteKey);
      if (uploadComplete === 'true') {
        console.log('[DEBUG] Video upload completion detected in localStorage, refreshing videos...');
        localStorage.removeItem(uploadCompleteKey);
        refreshVideos();
      }
    };

    const interval = setInterval(checkUploadCompletion, 5000); // Check every 5 seconds

    return () => {
      window.removeEventListener('videoUploadComplete', handleVideoUploadComplete as EventListener);
      clearInterval(interval);
    };
  }, [eventId, refreshVideos]);

  useEffect(() => {
    const checkEventCreator = async () => {
      const event = await getEventById(eventId);
      const userEmail = localStorage.getItem('userEmail');
      if (event && userEmail) {
        setIsEventCreator(event.organizerId === userEmail);
        setEmailAccessList(event.emailAccess || []);
        setAnyoneCanUpload(event.anyoneCanUpload || false);
        setEventName(event.name || 'Untitled Event');
      }
    };
    checkEventCreator();
  }, [eventId]);

  // Intersection Observer for infinite scroll
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        const target = entries[0];
        if (target.isIntersecting && hasMoreImages && !loading && !fetchingImages) {
          const nextPage = currentPage + 1;
          console.log(`[DEBUG] Intersection observer triggered - nextPage: ${nextPage}, hasMore: ${hasMoreImages}, loading: ${loading}, fetching: ${fetchingImages}`);
          setCurrentPage(nextPage);
          fetchEventImages(nextPage, true);
        }
      },
      { threshold: 0.1 }
    );

    if (loadMoreRef.current) {
      observer.observe(loadMoreRef.current);
    }

    return () => observer.disconnect();
  }, [hasMoreImages, loading, currentPage, fetchingImages]);

  const fetchEventImages = async (page: number = 1, append: boolean = false) => {
    // Prevent multiple simultaneous calls
    if (fetchingImages) {
      console.log(`[DEBUG] fetchEventImages already in progress, skipping call for page ${page}`);
      return;
    }
    
    try {
      setFetchingImages(true);
      console.log(`[DEBUG] fetchEventImages called - page: ${page}, append: ${append}, current images count: ${images.length}`);
      
      if (!append) {
        setLoading(true);
      }
      const eventToUse = selectedEvent || eventId;
      const prefixes = [`events/shared/${eventToUse}/images`];
      let allImages: EventImage[] = [];

      for (const prefix of prefixes) {
        try {
          const { bucketName } = await validateEnvVariables();
          const listCommand = new ListObjectsV2Command({
            Bucket: bucketName,
            Prefix: prefix
          });
          const result = await (await s3ClientPromise).send(listCommand);
          if (result.Contents) {
            console.log(`[DEBUG] S3 returned ${result.Contents.length} items for prefix: ${prefix}`);
            // First deduplicate at S3 response level using a Set
            const uniqueKeys = new Set<string>();
            const imageItems = result.Contents
              .filter((item) => {
                if (!item.Key) return false;
                // Only include if we haven't seen this key before
                if (uniqueKeys.has(item.Key)) return false;
                uniqueKeys.add(item.Key);
                return item.Key.match(/\.(jpg|jpeg|png)$/i);
              })
              .map((item) => ({
                url: `https://${bucketName}.s3.amazonaws.com/${item.Key}`,
                key: item.Key || ''
              }));
            console.log(`[DEBUG] After S3 deduplication: ${imageItems.length} unique images`);
            allImages = [...allImages, ...imageItems];
          }
        } catch (error) {
          console.error(`Error fetching from path ${prefix}:`, error);
        }
      }

      if (allImages.length > 0) {
        // Apply additional deduplication as a safety measure
        const deduplicatedImages = deduplicateImages(allImages);
        console.log(`[DEBUG] Final deduplicated count: ${deduplicatedImages.length}`);
        
        if (!append) {
          setTotalImages(deduplicatedImages);
          const firstPageImages = deduplicatedImages.slice(0, imagesPerPage);
          setImages(firstPageImages);
          setHasMoreImages(deduplicatedImages.length > imagesPerPage);
          console.log(`[DEBUG] Set initial images: ${firstPageImages.length}, hasMore: ${deduplicatedImages.length > imagesPerPage}`);
        } else {
          const startIndex = images.length;
          const endIndex = startIndex + imagesPerPage;
          const nextPageImages = deduplicatedImages.slice(startIndex, endIndex);
          console.log(`[DEBUG] Appending images - start: ${startIndex}, end: ${endIndex}, nextPage: ${nextPageImages.length}`);
          // Only append if there are more images to load
          if (startIndex < deduplicatedImages.length) {
            setImages(prev => {
              const newImages = [...prev, ...nextPageImages];
              // Prevent exceeding the total
              return newImages.slice(0, deduplicatedImages.length);
            });
            setHasMoreImages(endIndex < deduplicatedImages.length);
          } else {
            setHasMoreImages(false);
          }
        }
        setError(null);
        setLoading(false);
      } else {
        // Don't set error immediately - wait to see if there are videos
        setImages([]);
        setTotalImages([]);
        setHasMoreImages(false);
        setLoading(false);
      }
    } catch (error: any) {
      console.error('Error fetching event images:', error);
      setError(error.message);
      setLoading(false);
    } finally {
      setFetchingImages(false);
    }
  };

  // Function to deduplicate images based on the filename after the timestamp code
  const deduplicateImages = (images: EventImage[]): EventImage[] => {
    const fileNameMap = new Map<string, EventImage>();
    const keyMap = new Map<string, EventImage>();
    
    console.log('Original images count:', images.length);
    console.log('Original image keys:', images.map(img => img.key));
    
    images.forEach((image, index) => {
      // First check: deduplicate by exact S3 key
      if (keyMap.has(image.key)) {
        console.log(`Duplicate S3 key found at index ${index}:`, image.key);
        return; // Skip this duplicate
      }
      keyMap.set(image.key, image);
      
      // Second check: deduplicate by filename (without extension)
      const keyParts = image.key.split('/');
      const fileName = keyParts[keyParts.length - 1]; // Get the actual filename
      
      if (fileName) {
        // Remove file extension for comparison
        const fileNameWithoutExt = fileName.replace(/\.(jpg|jpeg|png)$/i, '');
        
        // Keep the first occurrence of each unique filename
        if (!fileNameMap.has(fileNameWithoutExt)) {
          fileNameMap.set(fileNameWithoutExt, image);
        } else {
          console.log('Duplicate filename found:', fileNameWithoutExt, 'Original:', fileNameMap.get(fileNameWithoutExt)?.key, 'Duplicate:', image.key);
        }
      } else {
        // If we can't extract filename, use the full key as fallback
        fileNameMap.set(image.key, image);
      }
    });
    
    // Use the keyMap for final deduplication (more reliable)
    const deduplicated = Array.from(keyMap.values());
    console.log('Deduplicated images count:', deduplicated.length);
    console.log('Deduplicated image keys:', deduplicated.map(img => img.key));
    
    return deduplicated;
  };

  // Function to fetch event videos
  const fetchEventVideos = async () => {
    try {
      const eventToUse = selectedEvent || eventId;
      const prefixes = [`events/shared/${eventToUse}/videos`];
      let allVideos: EventVideo[] = [];

      for (const prefix of prefixes) {
        try {
          const { bucketName } = await validateEnvVariables();
          const listCommand = new ListObjectsV2Command({
            Bucket: bucketName,
            Prefix: prefix
          });
          const result = await (await s3ClientPromise).send(listCommand);
          if (result.Contents) {
            console.log(`[DEBUG] Found ${result.Contents.length} items in videos folder for event ${eventToUse}`);
            
            // Group video files by video ID (folder)
            const videoGroups = new Map<string, EventVideo>();
            
            result.Contents.forEach((item) => {
              if (item.Key) {
                console.log(`[DEBUG] Processing video item: ${item.Key}`);
                const keyParts = item.Key.split('/');
                console.log(`[DEBUG] Key parts:`, keyParts);
                
                if (keyParts.length >= 5) {
                  // Structure: events/shared/eventId/videos/videoId/filename
                  const videoId = keyParts[4]; // videoId is at index 4
                  const fileName = keyParts[keyParts.length - 1];
                  const videoName = keyParts[keyParts.length - 2] || 'Unknown Video';
                  
                  console.log(`[DEBUG] Video ID: ${videoId}, File Name: ${fileName}, Video Name: ${videoName}`);
                  
                  if (fileName === 'thumbnail.jpg') {
                    // This is a thumbnail
                    const videoKey = item.Key.replace('/thumbnail.jpg', '');
                    
                    if (!videoGroups.has(videoId)) {
                      videoGroups.set(videoId, {
                        url: `https://${bucketName}.s3.amazonaws.com/${videoKey}`,
                        key: videoKey,
                        thumbnailUrl: `https://${bucketName}.s3.amazonaws.com/${item.Key}`,
                        thumbnailKey: item.Key,
                        name: videoName
                      });
                      console.log(`[DEBUG] Created new video group for ${videoId} with thumbnail`);
                    } else {
                      // Update thumbnail
                      const video = videoGroups.get(videoId)!;
                      video.thumbnailUrl = `https://${bucketName}.s3.amazonaws.com/${item.Key}`;
                      video.thumbnailKey = item.Key;
                      console.log(`[DEBUG] Updated thumbnail for video ${videoId}`);
                    }
                  } else if (fileName.match(/\.(mp4|mov|avi|mkv|webm)$/i)) {
                    // This is a video file
                    const videoKey = item.Key;
                    
                    if (!videoGroups.has(videoId)) {
                      const videoUrl = `https://${bucketName}.s3.amazonaws.com/${videoKey}`;
                      videoGroups.set(videoId, {
                        url: videoUrl,
                        key: videoKey,
                        thumbnailUrl: '',
                        thumbnailKey: '',
                        name: videoName
                      });
                      console.log(`[DEBUG] Created new video group for ${videoId} with video file:`, {
                        videoId,
                        videoName,
                        videoUrl,
                        videoKey
                      });
                    } else {
                      // Update video URL
                      const video = videoGroups.get(videoId)!;
                      const videoUrl = `https://${bucketName}.s3.amazonaws.com/${videoKey}`;
                      video.url = videoUrl;
                      video.key = videoKey;
                      console.log(`[DEBUG] Updated video URL for ${videoId}:`, {
                        videoId,
                        videoName,
                        videoUrl,
                        videoKey
                      });
                    }
                  }
                } else {
                  console.log(`[DEBUG] Skipping item with insufficient key parts: ${item.Key}`);
                }
              }
            });
            
            allVideos = Array.from(videoGroups.values());
            console.log(`[DEBUG] Final video groups:`, allVideos);
          }
        } catch (error) {
          console.error(`Error fetching videos from path ${prefix}:`, error);
        }
      }

      console.log(`[DEBUG] Setting videos state with ${allVideos.length} videos`);
      setVideos(allVideos);
      
      // Clear error if videos are found
      if (allVideos.length > 0) {
        setError(null);
      }
    } catch (error: any) {
      console.error('Error fetching event videos:', error);
    }
  };

  const handleDownload = useCallback(async (url: string) => {
    try {
      const response = await fetch(url, {
        mode: 'cors',
        headers: { 'Cache-Control': 'no-cache' }
      });
      if (!response.ok) {
        throw new Error(`Failed to download file: ${response.statusText}`);
      }
      const contentType = response.headers.get('content-type');
      const isImage = contentType && contentType.includes('image/');
      const isVideo = contentType && contentType.includes('video/');
      
      if (!isImage && !isVideo) {
        throw new Error('Invalid file format received');
      }
      
      const blob = await response.blob();
      const fileName = decodeURIComponent(url.split('/').pop() || (isImage ? 'image.jpg' : 'video.mp4'));
      const link = document.createElement('a');
      link.href = window.URL.createObjectURL(blob);
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(link.href);
    } catch (error) {
      console.error('Error downloading file:', error);
      throw error;
    }
  }, []);

  const handleAddEmail = async () => {
    if (!emailInput || !emailInput.includes('@')) {
      alert('Please enter a valid email address');
      return;
    }

    const userEmail = localStorage.getItem('userEmail');
    if (!userEmail) {
      alert('User not authenticated');
      return;
    }

    try {
      const updatedEmailList = [...new Set([...emailAccessList, emailInput])];
      await updateEventData(eventId, userEmail, { emailAccess: updatedEmailList });
      setEmailAccessList(updatedEmailList);
      setEmailInput('');
    } catch (error) {
      console.error('Error adding email access:', error);
      alert('Failed to add email access');
    }
  };

  const handleRemoveEmail = async (emailToRemove: string) => {
    const userEmail = localStorage.getItem('userEmail');
    if (!userEmail) {
      alert('User not authenticated');
      return;
    }

    try {
      const updatedEmailList = emailAccessList.filter(email => email !== emailToRemove);
      await updateEventData(eventId, userEmail, { emailAccess: updatedEmailList });
      setEmailAccessList(updatedEmailList);
    } catch (error) {
      console.error('Error removing email access:', error);
      alert('Failed to remove email access');
    }
  };

  const handleAnyoneCanUploadChange = async (checked: boolean) => {
    const userEmail = localStorage.getItem('userEmail');
    if (!userEmail) {
      alert('User not authenticated');
      return;
    }

    try {
      await updateEventData(eventId, userEmail, { anyoneCanUpload: checked });
      setAnyoneCanUpload(checked);
    } catch (error) {
      console.error('Error updating anyone can upload setting:', error);
      alert('Failed to update upload settings');
    }
  };

  // Handler for toggling selection of an image
  const toggleSelectImage = (key: string) => {
    setSelectedImages(prev => {
      const newSet = new Set(prev);
      if (newSet.has(key)) {
        newSet.delete(key);
      } else {
        newSet.add(key);
      }
      return newSet;
    });
  };

  // Handler for toggling selection of a video
  const toggleSelectVideo = (key: string) => {
    setSelectedVideos(prev => {
      const newSet = new Set(prev);
      if (newSet.has(key)) {
        newSet.delete(key);
      } else {
        newSet.add(key);
      }
      return newSet;
    });
  };

  // Handler for Select All
  const handleSelectAll = () => {
    if (activeTab === 'photos') {
      if (selectedImages.size === images.length) {
        setSelectedImages(new Set());
      } else {
        setSelectedImages(new Set(images.map(img => img.key)));
      }
    } else if (activeTab === 'videos') {
      if (selectedVideos.size === videos.length) {
        setSelectedVideos(new Set());
      } else {
        setSelectedVideos(new Set(videos.map(video => video.key)));
      }
    }
  };

  // Handler for Cancel selection mode
  const handleCancelSelection = () => {
    setSelectionMode(false);
    setSelectedImages(new Set());
    setSelectedVideos(new Set());
  };



  // Handler for deleting selected images
  const handleDeleteSelected = async () => {
    setDeleting(true);
    setDeleteError(null);
    try {
      const { bucketName } = await validateEnvVariables();
      const keysToDelete = images.filter(img => selectedImages.has(img.key)).map(img => img.key);
      const deletedCount = keysToDelete.length;
      
      // Delete images from S3
      for (const key of keysToDelete) {
        try {
          const deleteCommand = new DeleteObjectCommand({
            Bucket: bucketName,
            Key: key,
          });
          await (await s3ClientPromise).send(deleteCommand);
        } catch (err) {
          setDeleteError('Failed to delete one or more images.');
          setDeleting(false);
          return;
        }
      }
      
      // Update event data in DynamoDB to reflect the deleted images
      try {
        const userEmail = localStorage.getItem('userEmail');
        if (userEmail) {
          const currentEvent = await getEventById(eventId);
          if (currentEvent) {
            // Updates photo count
            const newPhotoCount = Math.max(0, (currentEvent.photoCount || 0) - deletedCount);
            
            // Updates total image size with estimation
            const estimatedSizeReduction = deletedCount * 1024 * 1024; // 1MB per image
            const currentTotalSize = (currentEvent.totalImageSize || 0) * (currentEvent.totalImageSizeUnit === 'GB' ? 1024 : 1); // Convert to MB
            const newTotalSizeMB = Math.max(0, currentTotalSize - estimatedSizeReduction);
            
            // Convert back to appropriate unit
            const { size: newTotalSize, unit: newTotalUnit } = convertToAppropriateUnit(newTotalSizeMB * 1024 * 1024);
            
            await updateEventData(eventId, userEmail, {
              photoCount: newPhotoCount,
              totalImageSize: newTotalSize,
              totalImageSizeUnit: newTotalUnit,
              // Updates compressed size
              totalCompressedSize: Math.max(0, (currentEvent.totalCompressedSize || 0) - (deletedCount * 0.8)), // Assume 0.8MB compressed per image
              totalCompressedSizeUnit: currentEvent.totalCompressedSizeUnit || 'MB'
            });
            
            console.log(`[DEBUG] Updated event ${eventId} after deletion: -${deletedCount} photos, new total: ${newPhotoCount}, new size: ${newTotalSize} ${newTotalUnit}`);
          }
        }
      } catch (updateError) {
        console.error('Error updating event data after deletion:', updateError);
        // Don't fail the entire deletion if event update fails
        // The images are already deleted from S3
      }
      
      // Remove deleted images from UI
      setImages(prev => prev.filter(img => !selectedImages.has(img.key)));
      setSelectedImages(new Set());
      setSelectionMode(false);
      setShowDeleteModal(false);
      setDeleting(false);
      
      // Show success message
      alert(`Successfully deleted ${deletedCount} image${deletedCount !== 1 ? 's' : ''}.`);
      
    } catch (err: any) {
      setDeleteError(err.message || 'Failed to delete images.');
      setDeleting(false);
    }
  };

  // Navigation functions for enlarged image view
  const getCurrentImageIndex = () => {
    if (!selectedImage) return -1;
    return images.findIndex(img => img.key === selectedImage.key);
  };

  const goToNextImage = () => {
    const currentIndex = getCurrentImageIndex();
    if (currentIndex === -1) return;
    const nextIndex = (currentIndex + 1) % images.length;
    setSelectedImage(images[nextIndex]);
  };

  const goToPreviousImage = () => {
    const currentIndex = getCurrentImageIndex();
    if (currentIndex === -1) return;
    const prevIndex = currentIndex === 0 ? images.length - 1 : currentIndex - 1;
    setSelectedImage(images[prevIndex]);
  };

  // Keyboard navigation for enlarged image
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!selectedImage) return;
      
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        goToNextImage();
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        goToPreviousImage();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        setSelectedImage(null);
        toggleHeaderFooter(true);
      }
    };

    if (selectedImage) {
      document.addEventListener('keydown', handleKeyDown);
      return () => document.removeEventListener('keydown', handleKeyDown);
    }
  }, [selectedImage, images]);

  // Add handleShare function
  const handleShare = async (platform: string, imageUrl: string, e?: React.MouseEvent) => {
    if (e) {
      e.stopPropagation();
    }

    try {
      // Fetch the image and convert to blob
      const response = await fetch(imageUrl, {
        headers: {
          'Cache-Control': 'no-cache',
        },
        mode: 'cors',
      });
      
      if (!response.ok) {
        throw new Error(`Failed to fetch image: ${response.statusText}`);
      }
      
      const blob = await response.blob();
      const imageFile = new File([blob], 'photo.jpg', { type: blob.type });

      // If Web Share API is supported and platform is not specified (direct share button click)
      if (typeof navigator.share === 'function' && !platform) {
        try {
          await navigator.share({
            title: 'Check out this photo!',
            text: 'Photo from Chitralai',
            files: [imageFile]
          });
          setShareMenu(prev => ({ ...prev, isOpen: false }));
          return;
        } catch (err) {
          if (err instanceof Error && err.name !== 'AbortError') {
            console.error('Error sharing file:', err);
          }
        }
      }

      // Fallback to custom share menu for specific platforms
      const shareUrl = encodeURIComponent(imageUrl);
      const shareText = encodeURIComponent('Check out this photo!');
      
      let shareLink = '';
      switch (platform) {
        case 'facebook':
          shareLink = `https://www.facebook.com/sharer/sharer.php?u=${shareUrl}`;
          break;
        case 'twitter':
          shareLink = `https://twitter.com/intent/tweet?url=${shareUrl}&text=${shareText}`;
          break;
        case 'instagram':
          shareLink = `instagram://library?AssetPath=${shareUrl}`;
          break;
        case 'linkedin':
          shareLink = `https://www.linkedin.com/sharing/share-offsite/?url=${shareUrl}`;
          break;
        case 'whatsapp':
          shareLink = `https://api.whatsapp.com/send?text=${shareText}%20${shareUrl}`;
          break;
        case 'email':
          shareLink = `mailto:?subject=${shareText}&body=${shareUrl}`;
          break;
        case 'copy':
          try {
            await navigator.clipboard.writeText(imageUrl);
            alert('Link copied to clipboard!');
            setShareMenu(prev => ({ ...prev, isOpen: false }));
            return;
          } catch (err) {
            console.error('Failed to copy link:', err);
            alert('Failed to copy link');
          }
          break;
      }
      
      if (shareLink) {
        window.open(shareLink, '_blank', 'noopener,noreferrer');
        setShareMenu(prev => ({ ...prev, isOpen: false }));
      }
    } catch (error) {
      console.error('Error sharing image:', error);
      alert('Failed to share image. Please try again.');
    }
  };

  // Add useEffect for closing share menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (shareMenu.isOpen) {
        const target = event.target as HTMLElement;
        if (!target.closest('.share-menu')) {
          setShareMenu(prev => ({ ...prev, isOpen: false }));
        }
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [shareMenu.isOpen]);

  // Helper to get button style for anchoring to image
  const getButtonStyle = (button: 'close' | 'left' | 'right' | 'counter' | 'download' | 'rotate' | 'share', rotation: number) => {
    // Returns style object for absolute positioning and counter-rotation
    const inset = '2px';
    const base = {
      close: { top: inset, right: inset, zIndex: 10 },
      left: { top: '50%', left: inset, transform: 'translateY(-50%)', zIndex: 10 },
      right: { top: '50%', right: inset, transform: 'translateY(-50%)', zIndex: 10 },
      counter: { top: inset, left: inset, zIndex: 10 },
      download: { bottom: inset, right: '56px', zIndex: 10 }, // space for rotate
      rotate: { bottom: inset, right: inset, zIndex: 10 },
      share: { bottom: inset, left: inset, zIndex: 10 },
    } as const;
    return base[button];
  };

  // Helper to get image aspect ratio and dynamic overlay size
  const getOverlayStyle = (img: HTMLImageElement | null, rotation: number) => {
    // Default to 4:3 ratio if no image loaded
    let aspect = 4 / 3;
    if (img && img.naturalWidth && img.naturalHeight) {
      aspect = img.naturalWidth / img.naturalHeight;
      if (rotation % 180 !== 0) aspect = 1 / aspect;
    }
    // Outer modal is 90% width/height, inner overlay is 70% (gap is 10% on each side)
    return {
      width: aspect >= 1 ? '70%' : `${70 * aspect}%`,
      height: aspect >= 1 ? `${70 / aspect}%` : '70%',
      maxWidth: '70%',
      maxHeight: '70%',
      borderRadius: '2rem 2rem 4rem 4rem/3rem 3rem 6rem 6rem',
      background: 'rgba(255,255,255,0.7)',
      boxShadow: '0 4px 32px 0 rgba(0,0,0,0.10)',
      overflow: 'hidden',
      transform: `rotate(${rotation}deg)`
    };
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-gray-50">
        <div className="text-center p-8">
          <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-primary mx-auto"></div>
          <p className="mt-4 text-black-600">Loading event content...</p>
        </div>
      </div>
    );
  }

  // Only show error if there are no images AND no videos
  if (error && images.length === 0 && videos.length === 0) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-gray-50">
        <div className="text-center p-8 bg-white rounded-lg shadow-lg">
          <div className="text-blue-500 mb-4">⚠️</div>
          <p className="text-gray-800">No images or videos found for this event.</p>
          <Link to="/upload" className="mt-4 inline-flex items-center text-primary hover:text-secondary">
            <ArrowLeft className="w-4 h-4 sm:w-5 sm:h-5 mr-2" />
            Click to Upload images or videos
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col min-h-screen">
      {/* Add spacer for navbar */}
      <div className="h-20"></div>

      <main className="flex-1 container mx-auto px-3 sm:px-4 py-3 sm:py-4 md:py-8">
        {/* Header and controls */}
        <div className="flex flex-col space-y-3 sm:space-y-4 mb-4 sm:mb-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <Link
              to="/events"
              className="flex items-center text-gray-600 hover:text-primary transition-colors text-sm sm:text-base"
            >
              <ArrowLeft className="w-4 h-4 sm:w-5 sm:h-5 mr-2" />
              Back to Events
            </Link>
            <div className="text-xs sm:text-sm text-blue-500 flex items-center">
              Event Code:
              <span className="font-mono bg-gray-100 px-2 py-1 rounded ml-2 text-xs sm:text-sm">{eventId}</span>
              <button
                onClick={() => {
                  navigator.clipboard.writeText(eventId);
                  setShowCopyEventId(true);
                  setTimeout(() => setShowCopyEventId(false), 2000);
                }}
                className="ml-2 text-blue-500 hover:text-blue-700 transition-colors duration-200 flex items-center"
                aria-label="Copy event code"
                type="button"
              >
                {showCopyEventId ? (
                  <>
                    <CheckCircle className="w-4 h-4 sm:w-5 sm:h-5 text-blue-500" />
                    <span className="ml-1 text-blue-600 font-semibold text-xs sm:text-sm">Copied</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-4 h-4 sm:w-5 sm:h-5" />
                    <span className="ml-1 text-xs sm:text-sm">Copy</span>
                  </>
                )}
              </button>
            </div>
          </div>
          <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">{eventName}</h1>
        </div>

        

        {/* QR Code Modal */}
        {showQRModal && (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
            <div className="bg-white p-6 rounded-lg shadow-lg max-w-sm w-full">
              <div className="flex justify-between items-center mb-4">
                <h3 className="text-lg font-semibold">Scan QR Code</h3>
                <button
                  onClick={() => setShowQRModal(false)}
                  className="text-gray-500 hover:text-gray-700"
                >
                  <X size={24} />
                </button>
              </div>
              <div className="flex justify-center mb-4">
                <QRCodeSVG
                  value={`${window.location.origin}/attendee-dashboard?eventId=${eventId}`}
                  size={256}
                  level="H"
                  includeMargin={true}
                />
              </div>
              <p className="text-sm text-gray-600 text-center">
                Scan this QR code to access the event photos
              </p>
            </div>
          </div>
        )}
        
        {/* Button grid with consistent sizing */}
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-2 sm:gap-3 mb-6">
          <button
            onClick={() => setShowQRModal(true)}
            className="flex items-center justify-center bg-blue-200 text-black py-2 sm:py-3 px-2 sm:px-4 rounded-lg hover:bg-secondary transition-colors duration-200 h-10 sm:h-12 w-full"
          >
            <QRCodeSVG
              ref={qrCodeRef}
              value={`${window.location.origin}/attendee-dashboard?eventId=${eventId}`}
              size={20}
              level="H"
              includeMargin={true}
            />
            <span className="ml-1 sm:ml-2 text-xs sm:text-sm">Show QR</span>
          </button>
          
          <button
            onClick={() => {
              navigator.clipboard.writeText(
                `${window.location.origin}/attendee-dashboard?eventId=${eventId}`
              );
              setShowCopySuccess(true);
              setTimeout(() => setShowCopySuccess(false), 3000);
            }}
            className="flex items-center justify-center bg-blue-200 text-black py-2 sm:py-3 px-2 sm:px-4 rounded-lg hover:bg-secondary transition-colors duration-200 h-10 sm:h-12 w-full"
          >
            {showCopySuccess ? (
              <>
                <CheckCircle className="w-4 h-4 sm:w-5 sm:h-5 text-blue-500" />
                <span className="ml-1 sm:ml-2 text-xs sm:text-sm text-blue-600 font-semibold">Copied</span>
              </>
            ) : (
              <>
                <Copy className="w-4 h-4 sm:w-5 sm:h-5 mr-1 sm:mr-2" />
                <span className="text-xs sm:text-sm">Share Link</span>
              </>
            )}
          </button>
          
          <button
            onClick={() => {
              const allContent = [...images, ...videos];
              allContent.forEach((item, index) => {
                setTimeout(() => {
                  handleDownload(item.url);
                }, index * 500);
              });
            }}
            className="flex items-center justify-center bg-blue-200 text-black py-2 sm:py-3 px-2 sm:px-4 rounded-lg hover:bg-secondary transition-colors duration-200 h-10 sm:h-12 w-full"
            disabled={images.length === 0 && videos.length === 0}
          >
            <Download className="w-4 h-4 sm:w-5 sm:h-5 mr-1 sm:mr-2" />
            <span className="text-xs sm:text-sm">Download All Content</span>
          </button>
          
          <button
            onClick={() => navigate(`/upload?eventId=${eventId}`)}
            className="flex items-center justify-center bg-blue-200 text-black py-2 sm:py-3 px-2 sm:px-4 rounded-lg hover:bg-secondary transition-colors duration-200 h-10 sm:h-12 w-full"
          >
            <UploadIcon className="w-4 h-4 sm:w-5 sm:h-5 mr-1 sm:mr-2" />
            <span className="text-xs sm:text-sm">Upload</span>
          </button>
          
          {isEventCreator && (
            <button
              onClick={() => setShowAddAccessModal(true)}
              className="flex items-center justify-center bg-blue-200 text-black py-2 sm:py-3 px-2 sm:px-4 rounded-lg hover:bg-secondary transition-colors duration-200 h-10 sm:h-12 w-full"
            >
              <UserPlus className="w-4 h-4 sm:w-5 sm:h-5 mr-1 sm:mr-2" />
              <span className="text-xs sm:text-sm">Add Access</span>
            </button>
          )}
        </div>

        {uploading && (
          <div className="mb-4">
            <div className="w-full bg-gray-200 rounded-full h-2.5">
              <div
                className="bg-primary h-2.5 rounded-full transition-all duration-300"
                style={{ width: `${uploadProgress}%` }}
              />
            </div>
            <p className="text-center text-sm text-gray-600 mt-2">
              Uploading... {uploadProgress}%
            </p>
          </div>
        )}
         {/* Content Type Toggle */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between mb-4 relative gap-3">
          {/* Show message when no images but there are videos */}
          
          <div className="flex items-center bg-gray-100 p-1.5 rounded-xl w-full sm:w-auto shadow-sm">
            <button
              onClick={() => setActiveTab('photos')}
              className={`flex-1 sm:flex-none px-4 sm:px-6 py-3 rounded-lg font-semibold transition-all duration-300 text-sm sm:text-base relative ${
                activeTab === 'photos'
                  ? 'bg-white text-blue-600 shadow-md transform scale-105'
                  : 'text-gray-600 hover:text-gray-800 hover:bg-gray-50'
              }`}
            >
              <div className="flex items-center justify-center gap-2 sm:gap-3">
                <svg className={`w-5 h-5 sm:w-6 sm:h-6 transition-colors duration-300 ${
                  activeTab === 'photos' ? 'text-blue-600' : 'text-gray-500'
                }`} fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M4 3a2 2 0 00-2 2v10a2 2 0 002 2h12a2 2 0 002-2V5a2 2 0 00-2-2H4zm12 12H4l4-8 3 6 2-4 3 6z" clipRule="evenodd" />
                </svg>
                <div className="flex flex-col items-start">
                  <span className="font-medium">Photos</span>
                </div>
              </div>
            </button>
            <button
              onClick={() => setActiveTab('videos')}
              className={`flex-1 sm:flex-none px-4 sm:px-6 py-3 rounded-lg font-semibold transition-all duration-300 text-sm sm:text-base relative ${
                activeTab === 'videos'
                  ? 'bg-white text-blue-600 shadow-md transform scale-105'
                  : 'text-gray-600 hover:text-gray-800 hover:bg-gray-50'
              }`}
            >
              <div className="flex items-center gap-2">
                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                  <path d="M2 6a2 2 0 012-2h6l2 2h12a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6zM14 6l-2-2H4v6h12V6z"/>
                </svg>
                 Videos 
              </div>
            </button>
          </div>
          
          {activeTab === 'photos' && !selectionMode && (
            <button
              className="bg-blue-500 hover:bg-blue-600 text-white px-4 sm:px-6 py-3 rounded-lg hover:shadow-md transition-all duration-200 text-sm sm:text-base w-full sm:w-auto font-medium shadow-sm"
              onClick={() => setSelectionMode(true)}
            >
              <div className="flex items-center justify-center gap-2">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                Select Photos
              </div>
            </button>
          )}
          
          {activeTab === 'videos' && !selectionMode && (
            <button
              className="bg-blue-500 hover:bg-blue-600 text-white px-4 sm:px-6 py-3 rounded-lg hover:shadow-md transition-all duration-200 text-sm sm:text-base w-full sm:w-auto font-medium shadow-sm"
              onClick={() => setSelectionMode(true)}
            >
              <div className="flex items-center justify-center gap-2">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
                Select Videos
              </div>
            </button>
          )}
        </div>
        {selectionMode && (
          <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3 mb-4">
            <label className="flex items-center gap-2 select-none cursor-pointer order-1 sm:order-none">
              <input
                type="checkbox"
                checked={
                  activeTab === 'photos' 
                    ? selectedImages.size === images.length && images.length > 0
                    : selectedVideos.size === videos.length && videos.length > 0
                }
                ref={el => {
                  if (el) {
                    if (activeTab === 'photos') {
                      el.indeterminate = selectedImages.size > 0 && selectedImages.size < images.length;
                    } else {
                      el.indeterminate = selectedVideos.size > 0 && selectedVideos.size < videos.length;
                    }
                  }
                }}
                onChange={handleSelectAll}
                className="w-4 h-4 sm:w-5 sm:h-5"
              />
              <span className="text-gray-700 text-sm sm:text-base">
                Select All {activeTab === 'photos' ? 'Photos' : 'Videos'}
              </span>
            </label>
            
            <div className="flex flex-wrap gap-2 w-full sm:w-auto order-2 sm:order-none">
              <button
                className="bg-blue-500 text-white px-3 sm:px-4 py-2 rounded hover:bg-blue-600 disabled:opacity-50 transition text-sm sm:text-base flex-1 sm:flex-none"
                disabled={
                  activeTab === 'photos' ? selectedImages.size === 0 : selectedVideos.size === 0
                }
                onClick={() => setShowShareModal(true)}
              >
                Share
              </button>
              <button
                className="bg-red-500 text-white px-3 sm:px-4 py-2 rounded hover:bg-red-600 disabled:opacity-50 transition text-sm sm:text-base flex-1 sm:flex-none"
                disabled={
                  activeTab === 'photos' ? selectedImages.size === 0 : selectedVideos.size === 0
                }
                onClick={() => setShowDeleteModal(true)}
              >
                Delete
              </button>
              <button
                className="bg-gray-200 text-gray-700 px-3 sm:px-4 py-2 rounded hover:bg-gray-300 transition text-sm sm:text-base flex-1 sm:flex-none"
                onClick={handleCancelSelection}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
        {/* Only show content area if there are images OR videos */}
        {(images.length > 0 || videos.length > 0) && (
          <div className="space-y-8">
            {/* Photos Tab Content */}
            {activeTab === 'photos' && (
            <div className="transition-all duration-300 ease-in-out">
              <div className="grid grid-cols-2 xs:grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7 gap-2 sm:gap-1.5 p-1.5">
                {images.map((image, idx) => (
                  <div
                    key={`${image.key}-${idx}`}
                    className="relative aspect-square overflow-hidden rounded-xl shadow-md cursor-pointer group"
                    onClick={() => {
                      if (selectionMode) {
                        toggleSelectImage(image.key);
                        return;
                      }
                      setSelectedImage(image);
                      toggleHeaderFooter(false);
                    }}
                  >
                    {/* Checkbox overlay in selection mode */}
                    {selectionMode && (
                      <input
                        type="checkbox"
                        checked={selectedImages.has(image.key)}
                        onChange={() => toggleSelectImage(image.key)}
                        className="absolute top-2 left-2 z-20 w-5 h-5 accent-blue-500 border-blue-400 focus:ring-blue-300 bg-white border-2 rounded focus:ring-2"
                        onClick={e => e.stopPropagation()}
                      />
                    )}
                    <img
                      src={image.url}
                      alt={`Event photo ${idx + 1}`}
                      className="w-full h-full object-cover"
                      loading="lazy"
                    />
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDownload(image.url);
                      }}
                      className="absolute top-2 right-2 p-1 rounded-full bg-black/50 text-white hover:bg-black/70 transition-colors duration-200"
                    >
                      <Download className="h-4 w-4" />
                    </button>
                  </div>
                ))}
              </div>
              
              {/* Infinite Scroll Trigger */}
              {hasMoreImages && images.length > 0 && (
                <div ref={loadMoreRef} className="h-4"></div>
              )}
              
              {/* Loading indicator for infinite scroll */}
              {loading && hasMoreImages && (
                <div className="flex justify-center mt-8">
                  <div className="flex items-center gap-2 text-gray-600">
                    <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-blue-600"></div>
                    Loading more images...
                  </div>
                </div>
              )}
              
              {/* Empty state for photos */}
              {!loading && images.length === 0 && (
                <div className="text-center py-12 sm:py-16 bg-gray-50 rounded-lg">
                  <Camera className="w-12 h-12 sm:w-16 sm:h-16 text-gray-400 mx-auto mb-4" />
                  <p className="text-lg sm:text-xl text-gray-600">No photos found for this event</p>
                  <p className="text-sm sm:text-base text-gray-400 mt-2 px-4">
                    {videos.length > 0 ? 'Check the Videos tab for event content' : 'Photos uploaded to this event will appear here'}
                  </p>
                </div>
              )}
            </div>
          )}
          
          {/* Videos Tab Content */}
          {activeTab === 'videos' && (
            <div className="mt-8">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between mb-4 gap-3">
                <h3 className="text-lg sm:text-xl font-semibold text-gray-900 flex items-center">
                  <svg className="w-5 h-5 sm:w-6 sm:h-6 mr-2 text-blue-600" fill="currentColor" viewBox="0 0 20 20">
                    <path d="M2 6a2 2 0 012-2h6l2 2h6a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6zM14 6l-2-2H4v6h12V6z"/>
                  </svg>
                  Event Videos ({videos.length})
                </h3>
                <div className="flex items-center gap-2">
                  <button
                    onClick={refreshVideos}
                    className="flex items-center gap-2 px-3 py-2 text-sm bg-blue-100 text-blue-700 rounded-lg hover:bg-blue-200 transition-colors duration-200 w-full sm:w-auto justify-center"
                    title="Refresh videos"
                  >
                    <RotateCw className="w-4 h-4" />
                    Refresh
                  </button>
                </div>
              </div>
              
              {videos.length > 0 ? (
                <div className="grid grid-cols-1 xs:grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3 sm:gap-4">
                  {videos.map((video, idx) => (
                    <div
                      key={`${video.key}-${idx}`}
                      className="relative aspect-video overflow-hidden rounded-xl shadow-md cursor-pointer group bg-gray-100"
                      onClick={() => {
                        if (selectionMode) {
                          toggleSelectVideo(video.key);
                          return;
                        }
                        setSelectedVideo(video);
                      }}
                    >
                      {/* Checkbox overlay in selection mode */}
                      {selectionMode && (
                        <input
                          type="checkbox"
                          checked={selectedVideos.has(video.key)}
                          onChange={() => toggleSelectVideo(video.key)}
                          className="absolute top-2 left-2 z-20 w-5 h-5 accent-blue-500 border-blue-400 focus:ring-blue-300 bg-white border-2 rounded focus:ring-2"
                          onClick={e => e.stopPropagation()}
                        />
                      )}
                      
                      {video.thumbnailUrl ? (
                        <img
                          src={video.thumbnailUrl}
                          alt={`Video thumbnail ${idx + 1}`}
                          className="w-full h-full object-cover"
                          loading="lazy"
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center bg-gray-100">
                          <video
                            src={video.url}
                            className="w-full h-full object-cover"
                            muted
                            preload="metadata"
                          />
                        </div>
                      )}
                      
                      {/* Play button overlay */}
                      <div className="absolute inset-0 flex items-center justify-center bg-black bg-opacity-20 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
                        <div className="w-16 h-16 bg-white bg-opacity-90 rounded-full flex items-center justify-center">
                          <svg className="w-8 h-8 text-gray-800 ml-1" fill="currentColor" viewBox="0 0 20 20">
                            <path d="M8 5v10l8-5-8-5z"/>
                          </svg>
                        </div>
                      </div>
                      
                      {/* Video info */}
                      <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/70 to-transparent p-3">
                        <p className="text-white text-sm font-medium truncate">{video.name}</p>
                      </div>
                      
                      {/* Download button */}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDownload(video.url);
                        }}
                        className="absolute top-2 right-2 p-1 rounded-full bg-black/50 text-white hover:bg-black/70 transition-colors duration-200"
                      >
                        <Download className="h-4 w-4" />
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center py-8 bg-gray-50 rounded-lg">
                  <svg className="w-12 h-12 sm:w-16 sm:h-16 text-gray-400 mx-auto mb-4" fill="currentColor" viewBox="0 0 20 20">
                    <path d="M2 6a2 2 0 012-2h6l2 2h6a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6zM14 6l-2-2H4v6h12V6z"/>
                  </svg>
                  <p className="text-lg sm:text-xl text-gray-600">No videos found for this event</p>
                  <p className="text-sm sm:text-base text-gray-400 mt-2 px-4">
                    {images.length > 0 ? 'Check the Photos tab for event content' : 'Videos uploaded to this event will appear here'}
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
        )}
        



        {selectedImage && (
          <div 
            className="fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center z-50 p-4"
            onClick={() => {
              setSelectedImage(null);
              toggleHeaderFooter(true);
            }}
          >
            <div
              className="relative flex items-center justify-center bg-black rounded-2xl shadow-xl overflow-hidden"
              style={{
                width: 'min(90vw, 90vh)',
                height: 'min(90vw, 90vh)',
                minWidth: 320,
                minHeight: 320,
                maxWidth: 900,
                maxHeight: 900,
                aspectRatio: '1/1',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                boxSizing: 'border-box',
                padding: 0,
              }}
              onClick={e => e.stopPropagation()}
            >
              <div
                className="flex items-center justify-center w-full h-full"
                style={{
                  boxSizing: 'border-box',
                  padding: 5,
                  width: '100%',
                  height: '100%',
                }}
              >
                <img
                  id="modal-img"
                  src={selectedImage.url}
                  alt="Enlarged event photo"
                  className="object-contain"
                  style={{
                    width: '100%',
                    height: '100%',
                    maxWidth: '100%',
                    maxHeight: '100%',
                    borderRadius: 'inherit',
                    display: 'block',
                    transform: `rotate(${rotation}deg)`,
                    transition: 'transform 0.3s',
                    background: 'transparent',
                    pointerEvents: 'auto',
                    userSelect: 'none',
                  }}
                />
              </div>
              {/* Close button */}
              <button
                className="absolute p-2 sm:p-3 rounded-full bg-black/40 text-white hover:bg-black/70 transition-colors duration-200 shadow-lg"
                onClick={() => {
                  setSelectedImage(null);
                  toggleHeaderFooter(true);
                }}
                style={{ top: 12, right: 12, zIndex: 10 }}
                title="Close"
              >
                <X className="w-5 h-5 sm:w-8 sm:h-8" />
              </button>
              {/* Navigation arrows */}
              {images.length > 1 && (
                <>
                  <button
                    onClick={e => {
                      e.stopPropagation();
                      goToPreviousImage();
                    }}
                    className="absolute p-2 sm:p-3 rounded-full bg-black/40 text-white hover:bg-black/70 transition-colors duration-200 shadow-lg"
                    title="Previous image (←)"
                    style={{ left: 12, top: '50%', transform: 'translateY(-50%)', zIndex: 10 }}
                  >
                    <ChevronLeft className="w-5 h-5 sm:w-8 sm:h-8" />
                  </button>
                  <button
                    onClick={e => {
                      e.stopPropagation();
                      goToNextImage();
                    }}
                    className="absolute p-2 sm:p-3 rounded-full bg-black/40 text-white hover:bg-black/70 transition-colors duration-200 shadow-lg"
                    title="Next image (→)"
                    style={{ right: 12, top: '50%', transform: 'translateY(-50%)', zIndex: 10 }}
                  >
                    <ChevronRight className="w-5 h-5 sm:w-8 sm:h-8" />
                  </button>
                </>
              )}
              {/* Image counter */}
              {images.length > 1 && (
                <div className="absolute px-3 py-1 sm:px-4 sm:py-2 rounded-full bg-black/40 text-white text-xs sm:text-sm shadow-lg" style={{ top: 12, left: 12, zIndex: 10 }}>
                  {getCurrentImageIndex() + 1} / {images.length}
                </div>
              )}
              {/* Download and Rotate buttons at bottom-right with more spacing */}
              <div className="absolute flex space-x-3 sm:space-x-6" style={{ bottom: 12, right: 20, zIndex: 10 }}>
                <button
                  onClick={e => {
                    e.stopPropagation();
                    handleDownload(selectedImage.url);
                  }}
                  className="p-2 sm:p-3 rounded-full bg-black/40 text-white hover:bg-black/70 transition-colors duration-200 shadow-lg"
                  title="Download"
                >
                  <Download className="w-5 h-5 sm:w-6 sm:h-6" />
                </button>
                <button
                  onClick={e => {
                    e.stopPropagation();
                    setRotation(r => (r + 90) % 360);
                  }}
                  className="p-2 sm:p-3 rounded-full bg-black/40 text-white hover:bg-black/70 transition-colors duration-200 shadow-lg"
                  title="Rotate image"
                >
                  <RotateCw className="w-5 h-5 sm:w-6 sm:h-6" />
                </button>
              </div>
              {/* Share button at bottom-left */}
              <button
                onClick={e => {
                  e.stopPropagation();
                  const rect = e.currentTarget.getBoundingClientRect();
                  if (typeof navigator !== 'undefined' && 'share' in navigator) {
                    handleShare('', selectedImage.url, e);
                  } else {
                    setShareMenu({
                      isOpen: true,
                      imageUrl: selectedImage.url,
                      position: {
                        top: rect.top - 200,
                        left: rect.left - 200
                      }
                    });
                  }
                }}
                className="absolute p-2 sm:p-3 rounded-full bg-black/40 text-white hover:bg-black/70 transition-colors duration-200 shadow-lg"
                style={{ bottom: 12, left: 12, zIndex: 10 }}
                title="Share"
              >
                <Share2 className="w-5 h-5 sm:w-6 sm:h-6" />
              </button>
            </div>
          </div>
        )}

        {/* Video Modal */}
        {selectedVideo && (
          <div 
            className="fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center z-50 p-4"
            onClick={() => {
              setSelectedVideo(null);
              toggleHeaderFooter(true);
            }}
          >
            <div
              className="relative flex items-center justify-center bg-black rounded-2xl shadow-xl overflow-hidden"
              style={{
                width: 'min(90vw, 90vh)',
                height: 'min(90vw, 90vh)',
                minWidth: 320,
                minHeight: 320,
                maxWidth: 1200,
                maxHeight: 800,
                aspectRatio: '16/9',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                boxSizing: 'border-box',
                padding: 0,
              }}
              onClick={e => e.stopPropagation()}
            >
              <div
                className="flex items-center justify-center w-full h-full"
                style={{
                  boxSizing: 'border-box',
                  padding: 5,
                  width: '100%',
                  height: '100%',
                }}
              >
                <video
                  src={selectedVideo.url}
                  controls
                  autoPlay
                  className="object-contain"
                  style={{
                    width: '100%',
                    height: '100%',
                    maxWidth: '100%',
                    maxHeight: '100%',
                    borderRadius: 'inherit',
                    display: 'block',
                    background: 'transparent',
                    pointerEvents: 'auto',
                    userSelect: 'none',
                  }}
                />
              </div>
              {/* Close button */}
              <button
                className="absolute p-2 sm:p-3 rounded-full bg-black/40 text-white hover:bg-black/70 transition-colors duration-200 shadow-lg"
                onClick={() => {
                  setSelectedVideo(null);
                  toggleHeaderFooter(true);
                }}
                style={{ top: 12, right: 12, zIndex: 10 }}
                title="Close"
              >
                <X className="w-5 h-5 sm:w-8 sm:h-8" />
              </button>
              {/* Download button */}
              <button
                onClick={e => {
                  e.stopPropagation();
                  handleDownload(selectedVideo.url);
                }}
                className="absolute p-2 sm:p-3 rounded-full bg-black/40 text-white hover:bg-black/70 transition-colors duration-200 shadow-lg"
                style={{ bottom: 12, right: 12, zIndex: 10 }}
                title="Download"
              >
                <Download className="w-5 h-5 sm:w-6 sm:h-6" />
              </button>
            </div>
          </div>
        )}

        {/* Add Access Modal */}
        {showAddAccessModal && (
          <div className="fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center z-50 p-4" onClick={() => setShowAddAccessModal(false)}>
            <div className="relative bg-white rounded-lg shadow-xl p-8 max-w-md w-full mx-auto" onClick={e => e.stopPropagation()}>
              <button
                className="absolute top-4 right-4 p-2 rounded-full bg-gray-100 text-gray-600 hover:bg-gray-200 transition-colors duration-200"
                onClick={() => setShowAddAccessModal(false)}
              >
                <X className="w-6 h-6" />
              </button>
              <h3 className="text-xl font-semibold text-gray-900 mb-4">Manage Event Access</h3>
              
              {/* Anyone can upload checkbox */}
              <div className="mb-6">
                <label className="flex items-center space-x-2">
                  <input
                    type="checkbox"
                    checked={anyoneCanUpload}
                    onChange={(e) => handleAnyoneCanUploadChange(e.target.checked)}
                    className="form-checkbox h-5 w-5 text-blue-600 rounded border-gray-300 focus:ring-blue-500"
                  />
                  <span className="text-gray-700">Allow anyone to upload photos</span>
                </label>
              </div>

              {/* Share link button */}
              <div className="mb-6">
                <button
                  onClick={() => {
                    const uploadLink = `${window.location.origin}/upload?eventId=${eventId}`;
                    navigator.clipboard.writeText(uploadLink);
                    setShowCopyUpload(true);
                    setTimeout(() => setShowCopyUpload(false), 3000);
                  }}
                  className="w-full flex items-center justify-center bg-blue-100 text-blue-700 py-2 px-4 rounded-lg hover:bg-blue-200 transition-colors duration-200"
                >
                  {showCopyUpload ? (
                    <>
                      <CheckCircle className="w-4 h-4 text-blue-500" />
                      <span className="ml-1 text-blue-600 font-semibold">Copied</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-4 h-4 mr-2" />
                      Copy Upload Link
                    </>
                  )}
                </button>
              </div>

              <div className="mb-4">
                <div className="flex flex-col sm:flex-row gap-2">
                  <input
                    type="email"
                    value={emailInput}
                    onChange={(e) => setEmailInput(e.target.value)}
                    placeholder="Enter email address"
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  <button
                    onClick={handleAddEmail}
                    className="w-full sm:w-auto px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors duration-200 whitespace-nowrap"
                  >
                    Add
                  </button>
                </div>
              </div>
              <div className="space-y-2">
                <h4 className="font-medium text-gray-700">Current Access List:</h4>
                {emailAccessList.length === 0 ? (
                  <p className="text-gray-500">No emails added yet</p>
                ) : (
                  <ul className="space-y-2">
                    {emailAccessList.map((email) => (
                      <li key={email} className="flex items-center justify-between bg-gray-50 p-2 rounded-lg">
                        <span className="text-gray-700">{email}</span>
                        <button
                          onClick={() => handleRemoveEmail(email)}
                          className="p-1 text-red-500 hover:text-red-700 transition-colors duration-200"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Share Modal */}
        {showShareModal && (
          <div className="fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center z-50 p-4" onClick={() => setShowShareModal(false)}>
            <div className="relative bg-white rounded-lg shadow-xl p-8 max-w-md w-full mx-auto" onClick={e => e.stopPropagation()}>
              <button
                className="absolute top-4 right-4 p-2 rounded-full bg-gray-100 text-gray-600 hover:bg-gray-200 transition-colors duration-200"
                onClick={() => setShowShareModal(false)}
              >
                <X className="w-6 h-6" />
              </button>
              <h3 className="text-xl font-semibold text-gray-900 mb-4">Share Selected Images</h3>
              <p className="mb-4 text-gray-700">You have selected {selectedImages.size} image(s).</p>
              
              <div className="grid grid-cols-3 gap-4 mb-6">
                <button
                  onClick={(e) => {
                    const image = images.find(img => selectedImages.has(img.key));
                    if (image) {
                      handleShare('facebook', image.url, e);
                    }
                  }}
                  className="flex flex-col items-center justify-center p-3 hover:bg-gray-100 rounded-lg transition-colors"
                >
                  <Facebook className="h-8 w-8 text-blue-600" />
                  <span className="text-sm mt-1">Facebook</span>
                </button>
                <button
                  onClick={(e) => {
                    const image = images.find(img => selectedImages.has(img.key));
                    if (image) {
                      handleShare('instagram', image.url, e);
                    }
                  }}
                  className="flex flex-col items-center justify-center p-3 hover:bg-gray-100 rounded-lg transition-colors"
                >
                  <Instagram className="h-8 w-8 text-pink-600" />
                  <span className="text-sm mt-1">Instagram</span>
                </button>
                <button
                  onClick={(e) => {
                    const image = images.find(img => selectedImages.has(img.key));
                    if (image) {
                      handleShare('twitter', image.url, e);
                    }
                  }}
                  className="flex flex-col items-center justify-center p-3 hover:bg-gray-100 rounded-lg transition-colors"
                >
                  <Twitter className="h-8 w-8 text-blue-400" />
                  <span className="text-sm mt-1">Twitter</span>
                </button>
                <button
                  onClick={(e) => {
                    const image = images.find(img => selectedImages.has(img.key));
                    if (image) {
                      handleShare('linkedin', image.url, e);
                    }
                  }}
                  className="flex flex-col items-center justify-center p-3 hover:bg-gray-100 rounded-lg transition-colors"
                >
                  <Linkedin className="h-8 w-8 text-blue-700" />
                  <span className="text-sm mt-1">LinkedIn</span>
                </button>
                <button
                  onClick={(e) => {
                    const image = images.find(img => selectedImages.has(img.key));
                    if (image) {
                      handleShare('whatsapp', image.url, e);
                    }
                  }}
                  className="flex flex-col items-center justify-center p-3 hover:bg-gray-100 rounded-lg transition-colors"
                >
                  <MessageCircle className="h-8 w-8 text-blue-500" />
                  <span className="text-sm mt-1">WhatsApp</span>
                </button>
                <button
                  onClick={(e) => {
                    const image = images.find(img => selectedImages.has(img.key));
                    if (image) {
                      handleShare('email', image.url, e);
                    }
                  }}
                  className="flex flex-col items-center justify-center p-3 hover:bg-gray-100 rounded-lg transition-colors"
                >
                  <Mail className="h-8 w-8 text-gray-600" />
                  <span className="text-sm mt-1">Email</span>
                </button>
              </div>

              {selectedImages.size > 1 && (
                <div className="text-center text-sm text-gray-500 mb-4">
                  Note: Only the first selected image will be shared due to platform limitations.
                </div>
              )}

              {typeof navigator !== 'undefined' && 'share' in navigator && (
                <button
                  className="w-full bg-blue-500 text-white py-3 rounded-lg hover:bg-blue-600 transition flex items-center justify-center gap-2"
                  onClick={async () => {
                    try {
                      const selectedImage = images.find(img => selectedImages.has(img.key));
                      if (selectedImage) {
                        await handleShare('', selectedImage.url);
                        setShowShareModal(false);
                      }
                    } catch (e) {
                      // User cancelled or not supported
                    }
                  }}
                >
                  <Share2 className="w-5 h-5" />
                  Share via...
                </button>
              )}
            </div>
          </div>
        )}
        {/* Delete Modal */}
        {showDeleteModal && (
          <div className="fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center z-50 p-4" onClick={() => !deleting && setShowDeleteModal(false)}>
            <div className="relative bg-white rounded-lg shadow-xl p-8 max-w-md w-full mx-auto" onClick={e => e.stopPropagation()}>
              <button
                className="absolute top-4 right-4 p-2 rounded-full bg-gray-100 text-gray-600 hover:bg-gray-200 transition-colors duration-200"
                onClick={() => !deleting && setShowDeleteModal(false)}
                disabled={deleting}
              >
                <X className="w-6 h-6" />
              </button>
              <h3 className="text-xl font-semibold text-gray-900 mb-4">Delete Selected Images</h3>
              <p className="mb-6 text-gray-700">Are you sure you want to delete {selectedImages.size} image(s)? This action cannot be undone.</p>
              {deleteError && <div className="mb-4 text-red-500 text-sm">{deleteError}</div>}
              {deleting && (
                <div className="flex items-center justify-center mb-4">
                  <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-red-500"></div>
                  <span className="ml-3 text-gray-700">Deleting...</span>
                </div>
              )}
              <div className="flex gap-4 justify-end">
                <button
                  className="bg-gray-200 text-gray-700 px-4 py-2 rounded hover:bg-gray-300 transition"
                  onClick={() => setShowDeleteModal(false)}
                  disabled={deleting}
                >
                  Cancel
                </button>
                <button
                  className="bg-red-500 text-white px-4 py-2 rounded hover:bg-red-600 transition disabled:opacity-50"
                  onClick={handleDeleteSelected}
                  disabled={deleting}
                >
                  Delete
                </button>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
};

export default ViewEvent;
