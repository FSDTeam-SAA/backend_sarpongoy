import { v2 as cloudinary } from "cloudinary";
import streamifier from "streamifier";

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

/**
 * Upload file to Cloudinary from buffer
 * @param {Buffer} fileBuffer - File buffer from multer
 * @param {Object} options - Upload options
 * @returns {Promise<Object>} - Cloudinary upload result
 */
export const uploadOnCloudinary = (fileBuffer, options = {}) => {
  return new Promise((resolve, reject) => {
    const uploadOptions = {
      folder: options.folder || "fiverr-platform",
      resource_type: options.resource_type || "auto",
      transformation: options.transformation || [],
      ...options,
    };

    const uploadStream = cloudinary.uploader.upload_stream(
      uploadOptions,
      (error, result) => {
        if (error) {
          reject(error);
        } else {
          resolve(result);
        }
      },
    );

    streamifier.createReadStream(fileBuffer).pipe(uploadStream);
  });
};

/**
 * Delete file from Cloudinary
 * @param {String} publicId - Public ID of the file to delete
 * @param {String} resourceType - Type of resource (image, video, raw)
 * @returns {Promise<Object>} - Cloudinary delete result
 */
export const deleteFromCloudinary = async (publicId, resourceType = "auto") => {
  try {
    const result = await cloudinary.uploader.destroy(publicId, {
      resource_type: resourceType,
    });
    return result;
  } catch (error) {
    console.error("Error deleting from Cloudinary:", error);
    throw error;
  }
};

/**
 * Delete multiple files from Cloudinary
 * @param {Array<String>} publicIds - Array of public IDs
 * @param {String} resourceType - Type of resource
 * @returns {Promise<Object>} - Cloudinary delete result
 */
export const deleteMultipleFromCloudinary = async (
  publicIds,
  resourceType = "auto",
) => {
  try {
    const result = await cloudinary.api.delete_resources(publicIds, {
      resource_type: resourceType,
    });
    return result;
  } catch (error) {
    console.error("Error deleting multiple files from Cloudinary:", error);
    throw error;
  }
};

/**
 * Get file details from Cloudinary
 * @param {String} publicId - Public ID of the file
 * @param {String} resourceType - Type of resource
 * @returns {Promise<Object>} - File details
 */
export const getCloudinaryFileDetails = async (
  publicId,
  resourceType = "image",
) => {
  try {
    const result = await cloudinary.api.resource(publicId, {
      resource_type: resourceType,
    });
    return result;
  } catch (error) {
    console.error("Error getting Cloudinary file details:", error);
    throw error;
  }
};

export default cloudinary;
