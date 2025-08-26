// Video processing service for Chitralai

import { generateVideoThumbnail, extractVideoFrames, extractVideoMetadata } from '../utils/videoFormats';
import AWS from 'aws-sdk';
import { getRuntimeEnv } from './runtimeEnv';

export interface VideoFrame {
  timestamp: number;
  frameNumber: number;
  imageData: string; // base64 data URL
  s3Key?: string;
}

export interface VideoProcessingResult {
  videoKey: string;
  thumbnailKey: string;
  frames: VideoFrame[];
  metadata: {
    duration: number;
    width: number;
    height: number;
    frameRate: number;
    frameCount: number;
  };
  success: boolean;
  error?: string;
}

export interface VideoUploadProgress {
  stage: 'processing' | 'extracting' | 'uploading' | 'indexing';
  current: number;
  total: number;
  currentFile?: string;
  status: string;
}



export const uploadVideoToS3 = async (
  videoFile: File,
  eventId: string,
  videoId: string,
  videoName: string,
  onProgress?: (progress: VideoUploadProgress) => void
): Promise<VideoProcessingResult> => {
  try {
    console.log(`[videoProcessing] Starting video upload for: ${videoName}`);
    console.log(`[videoProcessing] Video file details:`, {
      name: videoFile.name,
      size: videoFile.size,
      type: videoFile.type,
      eventId,
      videoId
    });

    const env = await getRuntimeEnv();
    const bucketName = env.VITE_S3_BUCKET_NAME;
    
    if (!bucketName) {
      throw new Error('S3 bucket name not configured');
    }

    // Initialize AWS SDK v2 S3 client
    const s3 = new AWS.S3({
      region: env.VITE_AWS_REGION,
      accessKeyId: env.VITE_AWS_ACCESS_KEY_ID,
      secretAccessKey: env.VITE_AWS_SECRET_ACCESS_KEY
    });

    // Extract video metadata
    onProgress?.({
      stage: 'processing',
      current: 10,
      total: 100,
      status: 'Extracting video metadata...'
    });

    console.log(`[videoProcessing] Extracting video metadata...`);
    const metadata = await extractVideoMetadata(videoFile);
    console.log(`[videoProcessing] Video metadata:`, metadata);

    // Extract frames
    onProgress?.({
      stage: 'processing',
      current: 20,
      total: 100,
      status: 'Extracting video frames...'
    });

    console.log(`[videoProcessing] Extracting video frames...`);
    const frames = await extractVideoFrames(videoFile, 10); // Extract 10 frames
    console.log(`[videoProcessing] Extracted ${frames.length} frames`);

    if (frames.length === 0) {
      console.warn(`[videoProcessing] Warning: No frames extracted from video ${videoName}`);
    }

    // Generate video key
    const videoKey = `events/shared/${eventId}/videos/${videoId}/${videoName}`;
    
    // Generate thumbnail
    onProgress?.({
      stage: 'processing',
      current: 40,
      total: 100,
      status: 'Generating thumbnail...'
    });

    // Generate thumbnail
    console.log(`[videoProcessing] Generating thumbnail...`);
    const thumbnail = await generateVideoThumbnail(videoFile);
    const thumbnailKey = `events/shared/${eventId}/videos/${videoId}/thumbnail.jpg`;
    
    console.log(`[videoProcessing] Uploading thumbnail...`);
    // Upload thumbnail
    const thumbnailBlob = await fetch(thumbnail).then(r => r.blob());
    await s3.upload({
      Bucket: bucketName,
      Key: thumbnailKey,
      Body: thumbnailBlob,
      ContentType: 'image/jpeg',
      ACL: 'public-read'
    }).promise();
    console.log(`[videoProcessing] Thumbnail uploaded successfully`);

    // Upload video file
    onProgress?.({
      stage: 'uploading',
      current: 60,
      total: 100,
      status: 'Uploading video file...'
    });

    console.log(`[videoProcessing] Uploading video file...`);
    // Use AWS SDK v2 upload method which handles browser compatibility better
    await s3.upload({
      Bucket: bucketName,
      Key: videoKey,
      Body: videoFile,
      ContentType: videoFile.type,
      ACL: 'public-read'
    }).promise();
    console.log(`[videoProcessing] Video file uploaded successfully`);

    // Upload frames
    onProgress?.({
      stage: 'uploading',
      current: 70,
      total: 100,
      status: 'Uploading video frames...'
    });

    console.log(`[videoProcessing] Uploading ${frames.length} frames...`);
    const uploadedFrames: VideoFrame[] = [];
    
    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i];
      const frameKey = `events/shared/${eventId}/videos/${videoId}/frames/frame_${frame.frameNumber}.jpg`;
      
      console.log(`[videoProcessing] Uploading frame ${i + 1}/${frames.length}: ${frameKey}`);
      const frameBlob = await fetch(frame.imageData).then(r => r.blob());
      await s3.upload({
        Bucket: bucketName,
        Key: frameKey,
        Body: frameBlob,
        ContentType: 'image/jpeg',
        ACL: 'public-read'
      }).promise();
      console.log(`[videoProcessing] Frame ${i + 1} uploaded successfully`);

      uploadedFrames.push({
        ...frame,
        s3Key: frameKey
      });

      onProgress?.({
        stage: 'uploading',
        current: 70 + ((i + 1) / frames.length) * 20,
        total: 100,
        status: `Uploaded frame ${i + 1} of ${frames.length}...`
      });
    }

    onProgress?.({
      stage: 'indexing',
      current: 95,
      total: 100,
      status: 'Processing complete!'
    });

    console.log(`[videoProcessing] Video processing completed successfully`);
    console.log(`[videoProcessing] Final result:`, {
      videoKey,
      thumbnailKey,
      frameCount: uploadedFrames.length,
      metadata: {
        ...metadata,
        frameCount: frames.length
      }
    });

    return {
      videoKey,
      thumbnailKey,
      frames: uploadedFrames,
      metadata: {
        ...metadata,
        frameCount: frames.length
      },
      success: true
    };

  } catch (error: any) {
    console.error('[videoProcessing] Error uploading video:', error);
    console.error('[videoProcessing] Error details:', {
      message: error.message,
      stack: error.stack,
      name: error.name,
      eventId,
      videoId,
      videoName
    });
    return {
      videoKey: '',
      thumbnailKey: '',
      frames: [],
      metadata: {
        duration: 0,
        width: 0,
        height: 0,
        frameRate: 0,
        frameCount: 0
      },
      success: false,
      error: error.message
    };
  }
};

export const getVideoUrl = (videoKey: string): string => {
  return `https://chitral-ai.s3.amazonaws.com/${videoKey}`;
};

export const getThumbnailUrl = (thumbnailKey: string): string => {
  return `https://chitral-ai.s3.amazonaws.com/${thumbnailKey}`;
};

export const getFrameUrl = (frameKey: string): string => {
  return `https://chitral-ai.s3.amazonaws.com/${frameKey}`;
};
