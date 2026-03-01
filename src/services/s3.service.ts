import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as AWS from 'aws-sdk';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class S3Service {
  private readonly logger = new Logger(S3Service.name);
  private readonly s3: AWS.S3;
  private readonly bucketName: string;
  private readonly region: string;

  constructor(private configService: ConfigService) {
    const accessKeyId = this.configService.get<string>('aws.accessKeyId') || '';
    const secretAccessKey = this.configService.get<string>('aws.secretAccessKey') || '';
    this.region = this.configService.get<string>('aws.region') || 'ap-south-1';
    this.bucketName = this.configService.get<string>('aws.bucketName') || '';

    if (accessKeyId && secretAccessKey) {
      this.s3 = new AWS.S3({
        accessKeyId,
        secretAccessKey,
        region: this.region,
      });
      this.logger.log('AWS S3 initialized');
    } else {
      this.logger.warn('AWS credentials not configured, using mock mode');
      // Create a mock S3 instance
      this.s3 = {} as AWS.S3;
    }
  }

  /**
   * Upload file to S3
   */
  async uploadFile(
    file: Buffer,
    filename: string,
    contentType: string,
    folder: string = 'uploads',
  ): Promise<string> {
    if (!this.bucketName || !this.s3.upload) {
      // Mock upload
      const mockUrl = `https://mock-s3.amazonaws.com/${this.bucketName}/${folder}/${filename}`;
      this.logger.log(`[MOCK S3] File uploaded: ${mockUrl}`);
      return mockUrl;
    }

    try {
      const key = `${folder}/${Date.now()}-${uuidv4()}-${filename}`;

      const params: AWS.S3.PutObjectRequest = {
        Bucket: this.bucketName,
        Key: key,
        Body: file,
        ContentType: contentType,
        ACL: 'public-read',
      };

      const result = await this.s3.upload(params).promise();
      this.logger.log(`File uploaded to S3: ${result.Location}`);
      return result.Location;
    } catch (error: any) {
      this.logger.error(`S3 upload failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Delete file from S3
   */
  async deleteFile(fileUrl: string): Promise<boolean> {
    if (!this.bucketName || !this.s3.deleteObject) {
      this.logger.log(`[MOCK S3] File deleted: ${fileUrl}`);
      return true;
    }

    try {
      // Extract key from URL
      const key = fileUrl.split(`${this.bucketName}/`)[1];

      if (!key) {
        this.logger.error('Invalid file URL');
        return false;
      }

      const params: AWS.S3.DeleteObjectRequest = {
        Bucket: this.bucketName,
        Key: key,
      };

      await this.s3.deleteObject(params).promise();
      this.logger.log(`File deleted from S3: ${key}`);
      return true;
    } catch (error: any) {
      this.logger.error(`S3 delete failed: ${error.message}`);
      return false;
    }
  }

  /**
   * Get signed URL for temporary access
   */
  async getSignedUrl(key: string, expiresIn: number = 3600): Promise<string> {
    if (!this.bucketName || !this.s3.getSignedUrl) {
      const mockUrl = `https://mock-s3.amazonaws.com/signed/${key}?expires=${expiresIn}`;
      this.logger.log(`[MOCK S3] Signed URL generated: ${mockUrl}`);
      return mockUrl;
    }

    try {
      const params = {
        Bucket: this.bucketName,
        Key: key,
        Expires: expiresIn,
      };

      const url = await this.s3.getSignedUrl('getObject', params);
      this.logger.log(`Signed URL generated for: ${key}`);
      return url;
    } catch (error: any) {
      this.logger.error(`Failed to generate signed URL: ${error.message}`);
      throw error;
    }
  }
}
