import { RekognitionClient, IndexFacesCommand, SearchFacesByImageCommand, DeleteFacesCommand, CreateCollectionCommand } from '@aws-sdk/client-rekognition';
import { s3ClientPromise, validateEnvVariables } from '../config/aws';
import { getRuntimeEnv } from './runtimeEnv';
import { HeadObjectCommand } from '@aws-sdk/client-s3';
import { ListObjectsV2Command } from '@aws-sdk/client-s3';

let rekognitionClientInstance: RekognitionClient | null = null;
let rekognitionClientInitializationPromise: Promise<RekognitionClient> | null = null;
async function initializeRekognitionClient(): Promise<RekognitionClient> {
  if (rekognitionClientInstance) return rekognitionClientInstance;
  if (rekognitionClientInitializationPromise) return rekognitionClientInitializationPromise;

  rekognitionClientInitializationPromise = (async () => {
    const env = await getRuntimeEnv();
    if (!env.VITE_AWS_REGION || !env.VITE_AWS_ACCESS_KEY_ID || !env.VITE_AWS_SECRET_ACCESS_KEY) {
      console.error('[faceRecognition.ts] Missing required environment variables for Rekognition: AWS Region, Access Key ID, Secret Access Key');
      throw new Error('Missing required environment variables for Rekognition');
    }

    console.log('[DEBUG] faceRecognition.ts: Initializing Rekognition Client with:');
    console.log('[DEBUG] faceRecognition.ts: Region:', env.VITE_AWS_REGION);
    console.log('[DEBUG] faceRecognition.ts: Access Key ID (first 5 chars):', env.VITE_AWS_ACCESS_KEY_ID.substring(0, 5));
    console.log('[DEBUG] faceRecognition.ts: Secret Access Key provided:', env.VITE_AWS_SECRET_ACCESS_KEY ? 'Yes' : 'No');

    rekognitionClientInstance = new RekognitionClient({
      region: env.VITE_AWS_REGION,
      credentials: {
        accessKeyId: env.VITE_AWS_ACCESS_KEY_ID,
        secretAccessKey: env.VITE_AWS_SECRET_ACCESS_KEY
      }
    });
    return rekognitionClientInstance;
  })();
  return rekognitionClientInitializationPromise;
}

// Create a collection for an event if it doesn't exist
export const createCollection = async (eventId: string): Promise<void> => {
  try {
    const rekognitionClient = await initializeRekognitionClient();
    const command = new CreateCollectionCommand({
      CollectionId: `event-${eventId}`,
    });
    await rekognitionClient.send(command);
    console.log(`[DEBUG] faceRecognition.ts: Successfully created collection for event ${eventId}`);
  } catch (error: any) {
    // If collection already exists, ignore the error
    if (error.name === 'ResourceAlreadyExistsException') {
      console.log(`[DEBUG] faceRecognition.ts: Collection already exists for event ${eventId}`);
      return;
    }
    console.error('[ERROR] faceRecognition.ts: Failed to create collection:', error);
    throw error;
  }
};

// Add a utility function for consistent filename sanitization
const sanitizeFilename = (filename: string): string => {
  if (!filename) return '';
  
  // Remove file extension first to handle it separately
  const lastDotIndex = filename.lastIndexOf('.');
  const nameWithoutExt = lastDotIndex > 0 ? filename.substring(0, lastDotIndex) : filename;
  const extension = lastDotIndex > 0 ? filename.substring(lastDotIndex) : '';
  
  // Handle special cases like (1), (2), etc. at the end
  const hasNumberInParentheses = nameWithoutExt.match(/\(\d+\)$/);
  const numberInParentheses = hasNumberInParentheses ? hasNumberInParentheses[0] : '';
  
  // Remove the number in parentheses from the filename for sanitization
  const nameWithoutNumber = nameWithoutExt.replace(/\(\d+\)$/, '');
  
  // Sanitize the main filename - replace ALL invalid characters with underscores
  // AWS Rekognition externalImageId pattern: [a-zA-Z0-9_.\-:]+
  const sanitized = nameWithoutNumber
    .replace(/[^a-zA-Z0-9_.\-:]/g, '_') // Replace invalid chars with underscore
    .replace(/_{2,}/g, '_') // Replace multiple underscores with single underscore
    .replace(/^_|_$/g, ''); // Remove leading/trailing underscores
  
  // Sanitize the extension (remove any invalid characters)
  const sanitizedExtension = extension.replace(/[^a-zA-Z0-9_.\-:]/g, '');
  
  // Combine sanitized name, number in parentheses, and sanitized extension
  const result = sanitized + numberInParentheses + sanitizedExtension;
  
  // Final safety check: ensure the result only contains valid characters
  const finalResult = result.replace(/[^a-zA-Z0-9_.\-:]/g, '_');
  
  console.log(`[DEBUG] sanitizeFilename: "${filename}" -> "${finalResult}"`);
  
  return finalResult;
};

// Utility function for exponential backoff delay
const getRetryDelay = (retryCount: number): number => {
  const baseDelay = 1000; // 1 second
  const maxDelay = 30000; // 30 seconds
  const delay = Math.min(baseDelay * Math.pow(2, retryCount), maxDelay);
  // Add jitter to prevent thundering herd
  return delay + Math.random() * 1000;
};

// Sleep utility function
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

// Optimized batch indexing function with rate limiting and retry logic
export const indexFacesBatch = async (
  eventId: string, 
  imageKeys: string[], 
  onProgress?: (completed: number, total: number, currentImage?: string) => void
): Promise<{
  successful: string[];
  failed: Array<{ imageKey: string; error: string }>;
}> => {
  const batchSize = 10; // Process 10 images at a time
  const delayBetweenBatches = 1000; // 1 second delay between batches
  const maxRetries = 3;
  
  const successful: string[] = [];
  const failed: Array<{ imageKey: string; error: string }> = [];
  
  console.log(`[DEBUG] faceRecognition.ts: Starting batch indexing for ${imageKeys.length} images in event ${eventId}`);
  
  // Process images in batches
  for (let i = 0; i < imageKeys.length; i += batchSize) {
    const batch = imageKeys.slice(i, i + batchSize);
    
    // Process each image in the current batch
    const batchPromises = batch.map(async (imageKey) => {
      let retryCount = 0;
      
      while (retryCount <= maxRetries) {
        try {
          if (onProgress) {
            onProgress(successful.length + failed.length, imageKeys.length, imageKey);
          }
          
          const faceIds = await indexFaces(eventId, imageKey);
          successful.push(imageKey);
          
          return;
          
        } catch (error: any) {
          retryCount++;
          
          // Check if it's a rate limit error
          if (error.name === 'ProvisionedThroughputExceededException' || 
              error.code === 'ProvisionedThroughputExceededException' ||
              error.message?.includes('Provisioned rate exceeded')) {
            
            if (retryCount <= maxRetries) {
              const delay = getRetryDelay(retryCount - 1);
              console.log(`[DEBUG] faceRecognition.ts: Rate limit hit for ${imageKey}, retrying in ${delay}ms (attempt ${retryCount}/${maxRetries})`);
              await sleep(delay);
              continue;
            }
          }
          
          // For other errors or max retries exceeded
          const errorMessage = error.message || error.toString();
          console.error(`[ERROR] faceRecognition.ts: Failed to index ${imageKey} after ${retryCount} attempts:`, errorMessage);
          failed.push({ imageKey, error: errorMessage });
          return;
        }
      }
    });
    
    // Wait for the current batch to complete
    await Promise.allSettled(batchPromises);
    
    // Add delay between batches (except for the last batch)
    if (i + batchSize < imageKeys.length) {
      console.log(`[DEBUG] faceRecognition.ts: Batch completed, waiting ${delayBetweenBatches}ms before next batch...`);
      await sleep(delayBetweenBatches);
    }
  }
  
  console.log(`[DEBUG] faceRecognition.ts: Batch indexing completed. Successful: ${successful.length}, Failed: ${failed.length}`);
  
  return { successful, failed };
};

// Index faces from an image in S3
export const indexFaces = async (eventId: string, imageKey: string, customExternalImageId?: string): Promise<string[]> => {
  try {
    const rekognitionClient = await initializeRekognitionClient();
    const { bucketName } = await validateEnvVariables();

    console.log(`[DEBUG] faceRecognition.ts: Indexing faces for image ${imageKey} in bucket ${bucketName}`);

    // Get the filename from the full path
    const filename = imageKey.split('/').pop() || '';
    
    // Check if this is a HEIC file that wasn't converted
    if (filename.toLowerCase().endsWith('.heic') || filename.toLowerCase().endsWith('.heif')) {
      console.warn(`[WARN] faceRecognition.ts: HEIC file detected: ${filename}. This should have been converted to JPEG before upload.`);
      throw new Error('HEIC format not supported by AWS Rekognition. Please convert to JPEG first.');
    }
    
    // Use custom external image ID if provided, otherwise sanitize the filename
    const externalImageId = customExternalImageId || sanitizeFilename(filename);

    console.log(`[DEBUG] faceRecognition.ts: Original filename: ${filename}`);
    console.log(`[DEBUG] faceRecognition.ts: External image ID: ${externalImageId}`);

    // Check if this image has already been indexed by searching for existing faces with this ExternalImageId
    try {
      const searchCommand = new SearchFacesByImageCommand({
        CollectionId: `event-${eventId}`,
        Image: {
          S3Object: {
            Bucket: bucketName,
            Name: imageKey
          }
        },
        MaxFaces: 1,
        FaceMatchThreshold: 95 // Very high threshold to find exact matches
      });
      
      const searchResponse = await rekognitionClient.send(searchCommand);
      
              // If we find matches with the same ExternalImageId, this image is already indexed
        if (searchResponse.FaceMatches && searchResponse.FaceMatches.length > 0) {
          const existingFaces = searchResponse.FaceMatches.filter(
            match => match.Face?.ExternalImageId === externalImageId
          );
          
          if (existingFaces.length > 0) {
            console.log(`[DEBUG] faceRecognition.ts: Image ${imageKey} already indexed with ${existingFaces.length} faces`);
            return existingFaces.map(face => face.Face?.FaceId || '').filter(id => id);
          }
        }
    } catch (searchError: any) {
      // If search fails (e.g., collection doesn't exist), continue with indexing
      console.log(`[DEBUG] faceRecognition.ts: Could not search existing faces (${searchError.message}), proceeding with indexing`);
    }

    // First verify if the file exists in S3 using the original key
    try {
      const s3Client = await s3ClientPromise;
      await s3Client.send(new HeadObjectCommand({
        Bucket: bucketName,
        Key: imageKey
      }));
    } catch (error: any) {
      console.error('[ERROR] faceRecognition.ts: S3 object not found:', {
        error: error.message,
        bucket: bucketName,
        key: imageKey
      });
      throw new Error(`Image not found in S3: ${imageKey}`);
    }

    const command = new IndexFacesCommand({
      CollectionId: `event-${eventId}`,
      Image: {
        S3Object: {
          Bucket: bucketName,
          Name: imageKey
        }
      },
      MaxFaces: 100,
      QualityFilter: 'NONE',
      DetectionAttributes: ['ALL'],
      ExternalImageId: externalImageId
    });

    const response = await rekognitionClient.send(command);
    const faceIds = response.FaceRecords?.map(record => record.Face?.FaceId || '') || [];
    
    console.log(`[DEBUG] faceRecognition.ts: Successfully indexed ${faceIds.length} faces for image ${imageKey}`);
    
    
    // Log any faces that were detected but not indexed
    if (response.UnindexedFaces && response.UnindexedFaces.length > 0) {
      console.log(`[DEBUG] faceRecognition.ts: ${response.UnindexedFaces.length} faces were detected but not indexed due to quality issues:`, 
        response.UnindexedFaces.map(face => ({
          reason: face.Reasons,
          confidence: face.FaceDetail?.Confidence
        }))
      );
    }
    
    return faceIds;
  } catch (error: any) {
    console.error('[ERROR] faceRecognition.ts: Failed to index faces:', {
      error: error.message,
      code: error.code,
      requestId: error.$metadata?.requestId,
      imageKey,
      eventId
    });
    throw error;
  }
};

// Search for faces in a collection using a selfie image
export const searchFacesByImage = async (eventId: string, selfieImageKey: string): Promise<{
  imageKey: string;
  similarity: number;
  type: 'image' | 'video';
  videoInfo?: {
    videoKey: string;
    videoName: string;
    thumbnailUrl: string;
    frameCount: number;
  };
}[]> => {
  try {
    const rekognitionClient = await initializeRekognitionClient();
    const { bucketName } = await validateEnvVariables();

    console.log(`[DEBUG] faceRecognition.ts: Searching faces for selfie ${selfieImageKey} in bucket ${bucketName}`);

    // Try to search in the collection first
    try {
      const command = new SearchFacesByImageCommand({
        CollectionId: `event-${eventId}`,
        Image: {
          S3Object: {
            Bucket: bucketName,
            Name: selfieImageKey
          }
        },
        MaxFaces: 50,
        FaceMatchThreshold: 70 // Lower threshold to catch more potential matches
      });

      const response = await rekognitionClient.send(command);
      
      console.log(`[DEBUG] faceRecognition.ts: Raw search response:`, {
        faceMatches: response.FaceMatches?.length || 0,
        collectionId: `event-${eventId}`,
        bucketName
      });
      
      // Create maps to store the best match for each unique image and video
      const uniqueImageMatches = new Map<string, { imageKey: string; similarity: number; type: 'image' }>();
      const uniqueVideoMatches = new Map<string, { 
        imageKey: string; 
        similarity: number; 
        type: 'video';
        videoInfo: {
          videoKey: string;
          videoName: string;
          thumbnailUrl: string;
          frameCount: number;
        };
      }>();

      // Process each face match
      for (const match of response.FaceMatches || []) {
        if (!match.Face?.ExternalImageId) {
          console.log(`[DEBUG] faceRecognition.ts: Skipping match without ExternalImageId:`, match);
          continue;
        }

        // Get the sanitized filename from ExternalImageId
        const sanitizedFilename = match.Face.ExternalImageId;
        const similarity = Math.round(match.Similarity || 0);
        
        console.log(`[DEBUG] faceRecognition.ts: Processing match:`, {
          externalImageId: sanitizedFilename,
          similarity,
          faceId: match.Face.FaceId
        });
        
        // Check if this is a video frame (contains '_frame_' in the ExternalImageId)
        if (sanitizedFilename.includes('_frame_')) {
          console.log(`[DEBUG] faceRecognition.ts: Detected video frame: ${sanitizedFilename}`);
          
          // This is a video frame - extract video information
          const frameMatch = sanitizedFilename.match(/^(.+)_frame_\d+$/);
          if (frameMatch) {
            const videoFilename = frameMatch[1];
            
            // Try to find the actual video file and get video info
            try {
              const s3Client = await s3ClientPromise;
              
              // Search for the video file in the videos directory
              const listCommand = new ListObjectsV2Command({
                Bucket: bucketName,
                Prefix: `events/shared/${eventId}/videos/`,
                MaxKeys: 1000
              });
              
              const listResponse = await s3Client.send(listCommand);
              
              if (listResponse.Contents) {
                // Find the video file that matches this filename
                const videoFile = listResponse.Contents.find(item => {
                  if (!item.Key) return false;
                  const itemFilename = item.Key.split('/').pop() || '';
                  // Check if the sanitized filename matches (after removing extension)
                  const sanitizedItemFilename = sanitizedFilename.replace(/[^a-zA-Z0-9_.\-:]/g, '_');
                  const matches = sanitizedItemFilename.includes(itemFilename.replace(/[^a-zA-Z0-9_.\-:]/g, '_'));
                  
                  console.log(`[DEBUG] faceRecognition.ts: Video file matching:`, {
                    frameFilename: sanitizedFilename,
                    videoFilename: itemFilename,
                    sanitizedFrame: sanitizedItemFilename,
                    sanitizedVideo: itemFilename.replace(/[^a-zA-Z0-9_.\-:]/g, '_'),
                    matches
                  });
                  
                  return matches;
                });
                
                console.log(`[DEBUG] faceRecognition.ts: Found video file:`, videoFile?.Key);
                
                if (videoFile?.Key) {
                  const videoKey = videoFile.Key;
                  const videoName = videoFile.Key.split('/').pop() || videoFilename;
                  
                  // Find thumbnail for this video
                  const thumbnailKey = videoKey.replace(/\.(mp4|avi|mov|wmv|flv|webm|mkv)$/i, '/thumbnail.jpg');
                  
                  // Count frames for this video
                  // Extract videoId from videoKey: events/shared/{eventId}/videos/{videoId}/filename.mp4
                  const videoKeyParts = videoKey.split('/');
                  const videoId = videoKeyParts[videoKeyParts.length - 2]; // Get the videoId part
                  const framePrefix = `events/shared/${eventId}/videos/${videoId}/frames/`;
                  console.log(`[DEBUG] faceRecognition.ts: Looking for frames in prefix: ${framePrefix}`);
                  
                  const frameListCommand = new ListObjectsV2Command({
                    Bucket: bucketName,
                    Prefix: framePrefix,
                    MaxKeys: 1000
                  });
                  
                  const frameListResponse = await s3Client.send(frameListCommand);
                  const frameCount = frameListResponse.Contents?.length || 0;
                  
                  console.log(`[DEBUG] faceRecognition.ts: Frame count for ${videoKey}: ${frameCount}`);
                  console.log(`[DEBUG] faceRecognition.ts: Frame keys found:`, frameListResponse.Contents?.map(item => item.Key));
                  
                  const videoInfo = {
                    videoKey,
                    videoName,
                    thumbnailUrl: `https://${bucketName}.s3.amazonaws.com/${thumbnailKey}`,
                    frameCount
                  };
                  
                  // Check if we already have a match for this video
                  const existingMatch = uniqueVideoMatches.get(videoKey);
                  
                  // Only update if this match has a higher similarity score
                  if (!existingMatch || similarity > existingMatch.similarity) {
                    uniqueVideoMatches.set(videoKey, {
                      imageKey: match.Face.ExternalImageId || '',
                      similarity,
                      type: 'video',
                      videoInfo
                    });
                    
                    console.log(`[DEBUG] faceRecognition.ts: Updated video match for ${videoKey}:`, {
                      similarity,
                      previousSimilarity: existingMatch?.similarity,
                      frameCount
                    });
                  }
                }
              }
            } catch (videoError) {
              console.log(`[DEBUG] faceRecognition.ts: Could not determine video info for frame ${sanitizedFilename}:`, videoError);
            }
          }
        } else {
          console.log(`[DEBUG] faceRecognition.ts: Detected regular image: ${sanitizedFilename}`);
          
          // This is a regular image
          // Convert back to original filename format
          let originalFilename = sanitizedFilename
            .replace(/_/g, ' ') // Replace underscores with spaces
            .replace(/\s*\((\d+)\)\s*$/, ' ($1)') // Fix number in parentheses format
            .trim() // Remove any leading/trailing spaces
            .replace(/\s+/g, '_'); // Replace spaces with underscores
          
          // Construct the full path
          const fullImageKey = `events/shared/${eventId}/images/${originalFilename}`;
          
          // Check if we already have a match for this image
          const existingMatch = uniqueImageMatches.get(fullImageKey);
          
          // Only update if this match has a higher similarity score
          if (!existingMatch || similarity > existingMatch.similarity) {
            uniqueImageMatches.set(fullImageKey, {
              imageKey: fullImageKey,
              similarity,
              type: 'image'
            });
            
            console.log(`[DEBUG] faceRecognition.ts: Updated image match for ${fullImageKey}:`, {
              similarity,
              previousSimilarity: existingMatch?.similarity
            });
          }
        }
      }

      // Combine image and video matches
      const imageMatches = Array.from(uniqueImageMatches.values());
      const videoMatches = Array.from(uniqueVideoMatches.values());
      
      console.log(`[DEBUG] faceRecognition.ts: Processing results:`, {
        totalMatches: response.FaceMatches?.length || 0,
        uniqueImages: imageMatches.length,
        uniqueVideos: videoMatches.length
      });
      
      const allMatches = [...imageMatches, ...videoMatches]
        .sort((a, b) => b.similarity - a.similarity)
        .filter(match => match.similarity >= 70); // Filter for minimum confidence

      // Log the final results
      console.log(`[DEBUG] faceRecognition.ts: Found ${allMatches.length} total matches:`, {
        images: imageMatches.length,
        videos: videoMatches.length
      });
      
      allMatches.forEach((match, index) => {
        if (match.type === 'video') {
          console.log(`[DEBUG] faceRecognition.ts: Video Match ${index + 1}:`, {
            video: match.videoInfo?.videoName,
            similarity: `${match.similarity}%`,
            frameCount: match.videoInfo?.frameCount
          });
        } else {
          console.log(`[DEBUG] faceRecognition.ts: Image Match ${index + 1}:`, {
            image: match.imageKey.split('/').pop(),
            similarity: `${match.similarity}%`
          });
        }
      });

      return allMatches;

    } catch (error: any) {
      // If collection doesn't exist, create it and index all images
      if (error.name === 'ResourceNotFoundException') {
        console.log(`[DEBUG] faceRecognition.ts: Collection doesn't exist for event ${eventId}, creating and indexing images...`);
        
        // Create collection and index all images
        const indexResult = await indexAllEventImages(eventId);
        
        if (indexResult.successful.length === 0) {
          throw new Error('No images were successfully indexed for this event.');
        }

        // Now try the search again with the same deduplication logic
        const retryCommand = new SearchFacesByImageCommand({
          CollectionId: `event-${eventId}`,
          Image: {
            S3Object: {
              Bucket: bucketName,
              Name: selfieImageKey
            }
          },
          MaxFaces: 50,
          FaceMatchThreshold: 70
        });

        const retryResponse = await rekognitionClient.send(retryCommand);
        
        console.log(`[DEBUG] faceRecognition.ts: Retry search after indexing returned ${retryResponse.FaceMatches?.length || 0} face matches`);
        
        // Use the same deduplication logic for retry, but also handle videos
        const uniqueRetryImageMatches = new Map<string, { imageKey: string; similarity: number; type: 'image' }>();
        const uniqueRetryVideoMatches = new Map<string, { 
          imageKey: string; 
          similarity: number; 
          type: 'video';
          videoInfo: {
            videoKey: string;
            videoName: string;
            thumbnailUrl: string;
            frameCount: number;
          };
        }>();
        
        // Process matches sequentially to handle async operations
        for (const match of retryResponse.FaceMatches || []) {
          if (!match.Face?.ExternalImageId) continue;
          
          const sanitizedFilename = match.Face.ExternalImageId;
          const similarity = Math.round(match.Similarity || 0);
          
          console.log(`[DEBUG] faceRecognition.ts: Processing retry match:`, {
            externalImageId: sanitizedFilename,
            similarity: similarity
          });
          
          // Check if this is a video frame
          if (sanitizedFilename.includes('_frame_')) {
            // This is a video frame - extract video information
            const frameMatch = sanitizedFilename.match(/^(.+)_frame_\d+$/);
            if (frameMatch) {
              const videoFilename = frameMatch[1];
              
              // Try to find the actual video file and get video info
              try {
                const s3Client = await s3ClientPromise;
                
                // Search for the video file in the videos directory
                const listCommand = new ListObjectsV2Command({
                  Bucket: bucketName,
                  Prefix: `events/shared/${eventId}/videos/`,
                  MaxKeys: 1000
                });
                
                const listResponse = await s3Client.send(listCommand);
                
                if (listResponse.Contents) {
                  // Find the video file that matches this filename
                  const videoFile = listResponse.Contents.find(item => {
                    if (!item.Key) return false;
                    const itemFilename = item.Key.split('/').pop() || '';
                    const sanitizedItemFilename = sanitizedFilename.replace(/[^a-zA-Z0-9_.\-:]/g, '_');
                    const matches = sanitizedItemFilename.includes(itemFilename.replace(/[^a-zA-Z0-9_.\-:]/g, '_'));
                    return matches;
                  });
                  
                  if (videoFile?.Key) {
                    const videoKey = videoFile.Key;
                    const videoName = videoFile.Key.split('/').pop() || videoFilename;
                    
                    // Find thumbnail for this video
                    const thumbnailKey = videoKey.replace(/\.(mp4|avi|mov|wmv|flv|webm|mkv)$/i, '/thumbnail.jpg');
                    
                    // Count frames for this video
                    const videoKeyParts = videoKey.split('/');
                    const videoId = videoKeyParts[videoKeyParts.length - 2];
                    const framePrefix = `events/shared/${eventId}/videos/${videoId}/frames/`;
                    
                    const frameListCommand = new ListObjectsV2Command({
                      Bucket: bucketName,
                      Prefix: framePrefix,
                      MaxKeys: 1000
                    });
                    
                    const frameListResponse = await s3Client.send(frameListCommand);
                    const frameCount = frameListResponse.Contents?.length || 0;
                    
                    const videoInfo = {
                      videoKey,
                      videoName,
                      thumbnailUrl: `https://${bucketName}.s3.amazonaws.com/${thumbnailKey}`,
                      frameCount
                    };
                    
                    // Check if we already have a match for this video
                    const existingMatch = uniqueRetryVideoMatches.get(videoKey);
                    
                    // Only update if this match has a higher similarity score
                    if (!existingMatch || similarity > existingMatch.similarity) {
                      uniqueRetryVideoMatches.set(videoKey, {
                        imageKey: match.Face.ExternalImageId || '',
                        similarity,
                        type: 'video',
                        videoInfo
                      });
                    }
                  }
                }
              } catch (videoError) {
                console.log(`[DEBUG] faceRecognition.ts: Could not determine video info for frame ${sanitizedFilename}:`, videoError);
              }
            }
          } else {
            // This is a regular image
            const fullImageKey = `events/shared/${eventId}/images/${sanitizedFilename}`;
            
            const existingMatch = uniqueRetryImageMatches.get(fullImageKey);
            if (!existingMatch || similarity > existingMatch.similarity) {
              uniqueRetryImageMatches.set(fullImageKey, {
                imageKey: fullImageKey,
                similarity: similarity,
                type: 'image'
              });
            }
          }
        }

        // Combine image and video matches
        const retryImageMatches = Array.from(uniqueRetryImageMatches.values());
        const retryVideoMatches = Array.from(uniqueRetryVideoMatches.values());
        
        const allRetryMatches = [...retryImageMatches, ...retryVideoMatches]
          .sort((a, b) => b.similarity - a.similarity)
          .filter(match => match.similarity >= 60);
        
        console.log(`[DEBUG] faceRecognition.ts: Final retry results for event ${eventId}:`, {
          total: allRetryMatches.length,
          images: retryImageMatches.length,
          videos: retryVideoMatches.length,
          imageKeys: retryImageMatches.map(m => m.imageKey),
          videoKeys: retryVideoMatches.map(m => m.videoInfo?.videoKey)
        });
        
        return allRetryMatches;
      }
      
      // For other errors, throw them
      throw error;
    }
  } catch (error: any) {
    console.error('[ERROR] faceRecognition.ts: Failed to search faces:', {
      error: error.message,
      code: error.code,
      requestId: error.$metadata?.requestId,
      selfieImageKey,
      eventId
    });
    throw error;
  }
};

// Delete faces from a collection
export const deleteFaces = async (eventId: string, faceIds: string[]): Promise<void> => {
  try {
    const rekognitionClient = await initializeRekognitionClient();
    console.log(`[DEBUG] faceRecognition.ts: Deleting ${faceIds.length} faces from event ${eventId}`);

    const command = new DeleteFacesCommand({
      CollectionId: `event-${eventId}`,
      FaceIds: faceIds
    });

    await rekognitionClient.send(command);
    console.log(`[DEBUG] faceRecognition.ts: Successfully deleted faces from event ${eventId}`);
  } catch (error: any) {
    console.error('[ERROR] faceRecognition.ts: Failed to delete faces:', {
      error: error.message,
      code: error.code,
      requestId: error.$metadata?.requestId,
      eventId,
      faceIds
    });
    throw error;
  }
};

// Function to index all existing images in an event
export const indexAllEventImages = async (
  eventId: string,
  onProgress?: (completed: number, total: number, currentImage?: string) => void
): Promise<{
  successful: string[];
  failed: Array<{ imageKey: string; error: string }>;
  totalImages: number;
}> => {
  try {
    const { bucketName } = await validateEnvVariables();
    const s3Client = await s3ClientPromise;
    
    console.log(`[DEBUG] faceRecognition.ts: Finding all images and video frames in event ${eventId}`);
    
    // List all images in the event folder
    const imageKeys: string[] = [];
    let continuationToken: string | undefined;
    
    do {
      const listCommand = new ListObjectsV2Command({
        Bucket: bucketName,
        Prefix: `events/shared/${eventId}/images/`,
        MaxKeys: 1000,
        ContinuationToken: continuationToken
      });
      
      const listResponse = await s3Client.send(listCommand);
      
      if (listResponse.Contents) {
        const validImageKeys = listResponse.Contents
          .filter(item => item.Key && /\.(jpg|jpeg|png)$/i.test(item.Key))
          .map(item => item.Key!);
        imageKeys.push(...validImageKeys);
      }
      
      continuationToken = listResponse.NextContinuationToken;
    } while (continuationToken);
    
    console.log(`[DEBUG] faceRecognition.ts: Found ${imageKeys.length} images to index in event ${eventId}`);
    
    // Also find and index video frames
    const videoFrameKeys: string[] = [];
    let videoContinuationToken: string | undefined;
    
    do {
      const videoListCommand = new ListObjectsV2Command({
        Bucket: bucketName,
        Prefix: `events/shared/${eventId}/videos/`,
        MaxKeys: 1000,
        ContinuationToken: videoContinuationToken
      });
      
      const videoListResponse = await s3Client.send(videoListCommand);
      
      if (videoListResponse.Contents) {
        // Look for frame directories within video folders
        for (const item of videoListResponse.Contents) {
          if (item.Key && item.Key.includes('/frames/')) {
            // This is a frame directory, list all frames in it
            const frameListCommand = new ListObjectsV2Command({
              Bucket: bucketName,
              Prefix: item.Key,
              MaxKeys: 1000
            });
            
            try {
              const frameListResponse = await s3Client.send(frameListCommand);
              if (frameListResponse.Contents) {
                const validFrameKeys = frameListResponse.Contents
                  .filter(frameItem => frameItem.Key && /\.(jpg|jpeg|png)$/i.test(frameItem.Key))
                  .map(frameItem => frameItem.Key!);
                videoFrameKeys.push(...validFrameKeys);
              }
            } catch (frameError) {
              console.log(`[DEBUG] faceRecognition.ts: Could not list frames in ${item.Key}:`, frameError);
            }
          }
        }
      }
      
      videoContinuationToken = videoListResponse.NextContinuationToken;
    } while (videoContinuationToken);
    
    console.log(`[DEBUG] faceRecognition.ts: Found ${videoFrameKeys.length} video frames to index in event ${eventId}`);
    
    if (imageKeys.length === 0 && videoFrameKeys.length === 0) {
      return { successful: [], failed: [], totalImages: 0 };
    }
    
    // Ensure collection exists
    await createCollection(eventId);
    
    // Index all images and video frames
    const allKeys = [...imageKeys, ...videoFrameKeys];
    const result = await indexFacesBatch(eventId, allKeys, onProgress);
    
    return {
      ...result,
      totalImages: allKeys.length
    };
    
  } catch (error: any) {
    console.error('[ERROR] faceRecognition.ts: Failed to index event images and video frames:', error);
    throw error;
  }
};

// Index faces from video frames
export const indexVideoFrames = async (
  eventId: string, 
  frameKeys: string[], 
  videoName: string,
  onProgress?: (completed: number, total: number, currentFrame?: string) => void
): Promise<{
  successful: string[];
  failed: Array<{ frameKey: string; error: string }>;
}> => {
  try {
    const rekognitionClient = await initializeRekognitionClient();
    const { bucketName } = await validateEnvVariables();

    console.log(`[DEBUG] faceRecognition.ts: Indexing faces for ${frameKeys.length} video frames in event ${eventId}`);

    // Ensure collection exists
    await createCollection(eventId);

    const successful: string[] = [];
    const failed: Array<{ frameKey: string; error: string }> = [];
    const batchSize = 5; // Process 5 frames at a time to avoid rate limits
    const delayBetweenBatches = 2000; // 2 second delay between batches

    for (let i = 0; i < frameKeys.length; i += batchSize) {
      const batch = frameKeys.slice(i, i + batchSize);
      
      const batchPromises = batch.map(async (frameKey, batchIndex) => {
        try {
          const frameNumber = i + batchIndex + 1;
          // Extract video filename from the frame key path
          // Frame key format: events/shared/{eventId}/videos/{videoId}/frames/frame_{number}.jpg
          const frameKeyParts = frameKey.split('/');
          const videoIdIndex = frameKeyParts.findIndex(part => part === 'videos');
          let videoFilename = videoName; // Fallback to provided videoName
          
          if (videoIdIndex !== -1 && videoIdIndex + 1 < frameKeyParts.length) {
            // Try to find the actual video file by looking for files in the video directory
            try {
              const s3Client = await s3ClientPromise;
              const listCommand = new ListObjectsV2Command({
                Bucket: bucketName,
                Prefix: `events/shared/${eventId}/videos/${frameKeyParts[videoIdIndex + 1]}/`,
                MaxKeys: 100
              });
              const listResponse = await s3Client.send(listCommand);
              
              if (listResponse.Contents) {
                // Find the video file (not thumbnail or frames)
                const videoFile = listResponse.Contents.find(item => 
                  item.Key && 
                  !item.Key.includes('/thumbnail.') && 
                  !item.Key.includes('/frames/') &&
                  /\.(mp4|avi|mov|wmv|flv|webm|mkv)$/i.test(item.Key)
                );
                
                if (videoFile?.Key) {
                  videoFilename = videoFile.Key.split('/').pop() || videoName;
                }
              }
            } catch (s3Error) {
              console.log(`[DEBUG] faceRecognition.ts: Could not determine video filename, using provided name: ${videoName}`);
            }
          }
          
          // Include video filename in external image ID for better tracking
          // Sanitize the video filename to comply with AWS Rekognition's externalImageId requirements
          const sanitizedVideoFilename = sanitizeFilename(videoFilename);
          const externalImageId = `${sanitizedVideoFilename}_frame_${frameNumber}`;
          
          console.log(`[DEBUG] faceRecognition.ts: Original video filename: ${videoFilename}`);
          console.log(`[DEBUG] faceRecognition.ts: Sanitized video filename: ${sanitizedVideoFilename}`);
          console.log(`[DEBUG] faceRecognition.ts: Final externalImageId: ${externalImageId}`);
          
          if (onProgress) {
            onProgress(successful.length + failed.length, frameKeys.length, frameKey);
          }

          const faceIds = await indexFaces(eventId, frameKey, externalImageId);
          successful.push(frameKey);
          
          console.log(`[DEBUG] faceRecognition.ts: Successfully indexed frame ${frameNumber} with ${faceIds.length} faces`);
          
        } catch (error: any) {
          const errorMessage = error.message || error.toString();
          console.error(`[ERROR] faceRecognition.ts: Failed to index frame ${frameKey}:`, errorMessage);
          failed.push({ frameKey, error: errorMessage });
        }
      });

      // Wait for the current batch to complete
      await Promise.allSettled(batchPromises);
      
      // Add delay between batches (except for the last batch)
      if (i + batchSize < frameKeys.length) {
        console.log(`[DEBUG] faceRecognition.ts: Batch completed, waiting ${delayBetweenBatches}ms before next batch...`);
        await sleep(delayBetweenBatches);
      }
    }

    console.log(`[DEBUG] faceRecognition.ts: Video frame indexing completed. Successful: ${successful.length}, Failed: ${failed.length}`);
    
    return { successful, failed };
    
  } catch (error: any) {
    console.error('[ERROR] faceRecognition.ts: Failed to index video frames:', error);
    throw error;
  }
}; 