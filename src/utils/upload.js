import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import dotenv from "dotenv";
import path from "path";
import { v4 as uuidv4 } from "uuid";

dotenv.config();

const s3Client = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const bucketName = process.env.AWS_S3_BUCKET_NAME;
const cloudfrontDomain = process.env.CLOUDFRONT_DOMAIN;

export const uploadFileToS3 = async (file) => {
  const ext = path.extname(file.originalname);
  const fileName = `${uuidv4()}${ext}`;

  const uploadParams = {
    Bucket: bucketName,
    Key: fileName,
    Body: file.buffer,
    ContentType: file.mimetype,
    // Remove ACL if your bucket policy is set correctly
    // ACL: "public-read",
  };

  try {
    await s3Client.send(new PutObjectCommand(uploadParams));

    // Return the CloudFront URL instead of S3 URL
    const fileUrl = `https://${cloudfrontDomain}/${fileName}`;

    return {
      url: fileUrl,
      key: fileName,
      filename: fileName,
    };
  } catch (error) {
    console.error("Error uploading file to S3:", error);
    throw error;
  }
};

export const deleteFileFromS3 = async (fileKey) => {
  const deleteParams = {
    Bucket: bucketName,
    Key: fileKey,
  };

  try {
    await s3Client.send(new DeleteObjectCommand(deleteParams));
    return true;
  } catch (error) {
    console.error("Error deleting file from S3:", error);
    throw error;
  }
};
