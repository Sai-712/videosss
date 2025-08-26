// Video format utilities for Chitralai

export interface VideoFormatInfo {
  format: string;
  extension: string;
  mimeType: string;
  isSupported: boolean;
  maxSize: number; // in bytes
}

export const SUPPORTED_VIDEO_FORMATS: VideoFormatInfo[] = [
  {
    format: 'MP4',
    extension: '.mp4',
    mimeType: 'video/mp4',
    isSupported: true,
    maxSize: 500 * 1024 * 1024 // 500MB
  },
  {
    format: 'MOV',
    extension: '.mov',
    mimeType: 'video/quicktime',
    isSupported: true,
    maxSize: 500 * 1024 * 1024 // 500MB
  },
  {
    format: 'AVI',
    extension: '.avi',
    mimeType: 'video/x-msvideo',
    isSupported: true,
    maxSize: 500 * 1024 * 1024 // 500MB
  },
  {
    format: 'MKV',
    extension: '.mkv',
    mimeType: 'video/x-matroska',
    isSupported: true,
    maxSize: 500 * 1024 * 1024 // 500MB
  },
  {
    format: 'WebM',
    extension: '.webm',
    mimeType: 'video/webm',
    isSupported: true,
    maxSize: 500 * 1024 * 1024 // 500MB
  }
];

export const isVideoFile = (file: File): boolean => {
  return SUPPORTED_VIDEO_FORMATS.some(format => 
    file.type === format.mimeType || 
    file.name.toLowerCase().endsWith(format.extension.toLowerCase())
  );
};

export const validateVideoFile = (file: File): { isValid: boolean; error?: string } => {
  // Check file type
  if (!isVideoFile(file)) {
    return { 
      isValid: false, 
      error: 'Unsupported video format. Please use MP4, MOV, AVI, MKV, or WebM.' 
    };
  }

  // Check file size (500MB limit)
  const maxSize = 500 * 1024 * 1024; // 500MB
  if (file.size > maxSize) {
    return { 
      isValid: false, 
      error: `Video file too large. Maximum size is 500MB. Current size: ${formatFileSize(file.size)}` 
    };
  }

  return { isValid: true };
};

export const formatFileSize = (bytes: number): string => {
  if (bytes === 0) return '0 Bytes';
  
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
};

export const getVideoFormatInfo = (file: File): VideoFormatInfo | null => {
  return SUPPORTED_VIDEO_FORMATS.find(format => 
    file.type === format.mimeType || 
    file.name.toLowerCase().endsWith(format.extension.toLowerCase())
  ) || null;
};

export const generateVideoThumbnail = async (file: File): Promise<string> => {
  console.log(`[generateVideoThumbnail] Starting thumbnail generation for: ${file.name}`);
  
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');

    if (!ctx) {
      console.error('[generateVideoThumbnail] Canvas context not available');
      reject(new Error('Canvas context not available'));
      return;
    }

    video.onloadedmetadata = () => {
      // Set video to 1 second mark for thumbnail
      video.currentTime = 1;
    };

    video.onseeked = () => {
      console.log(`[generateVideoThumbnail] Video seeked, generating thumbnail...`);
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      
      try {
        const thumbnailUrl = canvas.toDataURL('image/jpeg', 0.8);
        console.log(`[generateVideoThumbnail] Thumbnail generated successfully`);
        resolve(thumbnailUrl);
      } catch (error) {
        console.error(`[generateVideoThumbnail] Error generating thumbnail:`, error);
        reject(error);
      }
    };

    video.onerror = () => {
      reject(new Error('Failed to load video for thumbnail generation'));
    };

    video.src = URL.createObjectURL(file);
  });
};

export const extractVideoMetadata = async (file: File): Promise<{
  duration: number;
  width: number;
  height: number;
  frameRate: number;
}> => {
  console.log(`[extractVideoMetadata] Starting metadata extraction for: ${file.name}`);
  
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    
    video.onloadedmetadata = () => {
      const duration = video.duration || 0;
      const width = video.videoWidth || 0;
      const height = video.videoHeight || 0;
      
      // Estimate frame rate (this is approximate)
      const frameRate = 30; // Default assumption
      
      console.log(`[extractVideoMetadata] Metadata extracted:`, { duration, width, height, frameRate });
      
      resolve({
        duration,
        width,
        height,
        frameRate
      });
    };

    video.onerror = () => {
      console.error('[extractVideoMetadata] Error loading video metadata');
      reject(new Error('Failed to load video metadata'));
    };

    console.log(`[extractVideoMetadata] Setting video source...`);
    video.src = URL.createObjectURL(file);
  });
};

export const calculateOptimalFrameInterval = (duration: number, targetFrames: number = 10): number => {
  // Calculate interval between frames to get approximately targetFrames
  // Minimum 1 second interval, maximum 5 second interval
  const minInterval = 1;
  const maxInterval = 5;
  
  let interval = duration / targetFrames;
  
  if (interval < minInterval) {
    interval = minInterval;
  } else if (interval > maxInterval) {
    interval = maxInterval;
  }
  
  return Math.floor(interval);
};

export const generateFrameTimestamps = (duration: number, frameInterval: number): number[] => {
  const timestamps: number[] = [];
  let currentTime = frameInterval;
  
  while (currentTime < duration) {
    timestamps.push(currentTime);
    currentTime += frameInterval;
  }
  
  // Always include the last frame
  if (duration > 0) {
    timestamps.push(duration);
  }
  
  return timestamps;
};

export interface VideoFrame {
  frameNumber: number;
  timestamp: number;
  imageData: string; // Data URL of the frame
}

export const extractVideoFrames = async (file: File, targetFrames: number = 10): Promise<VideoFrame[]> => {
  console.log(`[extractVideoFrames] Starting frame extraction for: ${file.name}, target: ${targetFrames} frames`);
  
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');

    if (!ctx) {
      console.error('[extractVideoFrames] Canvas context not available');
      reject(new Error('Canvas context not available'));
      return;
    }

    const frames: VideoFrame[] = [];
    let currentTimestampIndex = 0;
    let currentTimestamp = 0;
    let hasError = false;

    video.onloadedmetadata = () => {
      console.log(`[extractVideoFrames] Video metadata loaded, duration: ${video.duration}s`);
      
      if (video.duration <= 0) {
        console.error('[extractVideoFrames] Invalid video duration:', video.duration);
        reject(new Error('Invalid video duration'));
        return;
      }

      // Calculate frame intervals
      const frameInterval = calculateOptimalFrameInterval(video.duration, targetFrames);
      const timestamps = generateFrameTimestamps(video.duration, frameInterval);
      
      console.log(`[extractVideoFrames] Generated ${timestamps.length} timestamps:`, timestamps);
      
      if (timestamps.length === 0) {
        // If no timestamps generated, create at least one frame at 1 second
        timestamps.push(1);
        console.log(`[extractVideoFrames] No timestamps generated, using default timestamp: 1s`);
      }

      const processFrame = () => {
        if (hasError) {
          console.log('[extractVideoFrames] Error occurred, stopping frame processing');
          return;
        }

        if (currentTimestampIndex >= timestamps.length) {
          console.log(`[extractVideoFrames] All frames processed, resolving with ${frames.length} frames`);
          if (frames.length === 0) {
            console.warn('[extractVideoFrames] Warning: No frames were successfully extracted');
          }
          resolve(frames);
          return;
        }

        currentTimestamp = timestamps[currentTimestampIndex];
        console.log(`[extractVideoFrames] Processing frame ${currentTimestampIndex + 1}/${timestamps.length} at ${currentTimestamp}s`);
        
        try {
          video.currentTime = currentTimestamp;
        } catch (error) {
          console.error(`[extractVideoFrames] Error setting video time to ${currentTimestamp}s:`, error);
          // Continue with next frame
          currentTimestampIndex++;
          setTimeout(processFrame, 100);
        }
      };

      video.onseeked = () => {
        console.log(`[extractVideoFrames] Video seeked to ${video.currentTime}s, capturing frame...`);
        
        try {
          // Set canvas dimensions to match video
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          
          if (canvas.width === 0 || canvas.height === 0) {
            console.warn(`[extractVideoFrames] Warning: Canvas dimensions are 0: ${canvas.width}x${canvas.height}`);
          }
          
          // Draw the current video frame to canvas
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          
          // Convert canvas to data URL
          const frameDataUrl = canvas.toDataURL('image/jpeg', 0.8);
          
          // Create frame object
          const frame: VideoFrame = {
            frameNumber: currentTimestampIndex + 1,
            timestamp: currentTimestamp,
            imageData: frameDataUrl
          };
          
          frames.push(frame);
          console.log(`[extractVideoFrames] Frame ${frame.frameNumber} captured successfully`);
          
          // Move to next frame
          currentTimestampIndex++;
          
          // Process next frame after a short delay to ensure video is ready
          setTimeout(processFrame, 100);
          
        } catch (error) {
          console.error(`[extractVideoFrames] Error capturing frame at ${currentTimestamp}s:`, error);
          // Continue with next frame even if this one fails
          currentTimestampIndex++;
          setTimeout(processFrame, 100);
        }
      };

      video.onerror = (event) => {
        console.error('[extractVideoFrames] Error during video processing:', event);
        hasError = true;
        reject(new Error('Failed to process video for frame extraction'));
      };

      // Start processing frames
      processFrame();
    };

    video.onerror = (event) => {
      console.error('[extractVideoFrames] Error loading video for frame extraction:', event);
      reject(new Error('Failed to load video for frame extraction'));
    };

    console.log(`[extractVideoFrames] Setting video source...`);
    video.src = URL.createObjectURL(file);
    
    // Add timeout to prevent hanging
    const timeout = setTimeout(() => {
      if (frames.length === 0) {
        console.error('[extractVideoFrames] Timeout: No frames extracted within reasonable time');
        reject(new Error('Timeout: Video frame extraction took too long'));
      }
    }, 30000); // 30 second timeout
    
    // Clean up timeout when resolving
    const originalResolve = resolve;
    resolve = (value: VideoFrame[] | PromiseLike<VideoFrame[]>) => {
      clearTimeout(timeout);
      if (Array.isArray(value)) {
        originalResolve(value);
      } else {
        value.then(originalResolve);
      }
    };
  });
};
