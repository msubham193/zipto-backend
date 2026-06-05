import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as AWS from 'aws-sdk';
import { v4 as uuidv4 } from 'uuid';

/**
 * Object storage service.
 *
 * Primary backend: Cloudflare R2 (S3-API compatible). Falls back to AWS S3 if
 * R2 is not configured. Driver KYC documents are PII, so the bucket is PRIVATE:
 * we store the object KEY in the DB and hand out short-lived PRESIGNED URLs at
 * read time (admin KYC view, driver profile). Legacy rows that still hold a full
 * https:// S3 URL are passed through unchanged for backward compatibility.
 */
@Injectable()
export class S3Service {
  private readonly logger = new Logger(S3Service.name);
  private readonly s3: AWS.S3;
  private readonly bucketName: string;
  private readonly region: string;
  private readonly isR2: boolean;
  /** Default presigned-URL lifetime (seconds). */
  private readonly defaultExpiry: number;

  constructor(private configService: ConfigService) {
    // R2 takes precedence; fall back to legacy AWS env for a smooth migration.
    const r2AccountId = (process.env.R2_ACCOUNT_ID || '').trim();
    const r2Endpoint =
      (process.env.R2_ENDPOINT || '').trim() ||
      (r2AccountId ? `https://${r2AccountId}.r2.cloudflarestorage.com` : '');

    const accessKeyId =
      (process.env.R2_ACCESS_KEY_ID || '').trim() ||
      this.configService.get<string>('aws.accessKeyId') ||
      '';
    const secretAccessKey =
      (process.env.R2_SECRET_ACCESS_KEY || '').trim() ||
      this.configService.get<string>('aws.secretAccessKey') ||
      '';

    this.isR2 = !!r2Endpoint;
    this.region = this.isR2
      ? 'auto'
      : this.configService.get<string>('aws.region') || 'ap-south-1';
    this.bucketName =
      (process.env.R2_BUCKET || '').trim() ||
      this.configService.get<string>('aws.bucketName') ||
      '';
    this.defaultExpiry = parseInt(process.env.STORAGE_URL_EXPIRY || '86400', 10); // 24h

    if (accessKeyId && secretAccessKey && this.bucketName) {
      this.s3 = new AWS.S3({
        accessKeyId,
        secretAccessKey,
        region: this.region,
        ...(this.isR2
          ? {
              endpoint: r2Endpoint,
              s3ForcePathStyle: true,
              signatureVersion: 'v4',
            }
          : {}),
      });
      this.logger.log(
        this.isR2
          ? `Cloudflare R2 storage initialized (bucket=${this.bucketName})`
          : `AWS S3 initialized (bucket=${this.bucketName})`,
      );
    } else {
      this.logger.warn('Object storage credentials not configured — using mock mode');
      this.s3 = {} as AWS.S3;
    }
  }

  private get isReady(): boolean {
    return !!this.bucketName && typeof this.s3.upload === 'function';
  }

  /**
   * Upload a file to the bucket and return the object KEY (not a URL).
   * Read paths convert the key to a presigned URL via {@link getSignedUrl}.
   */
  async uploadFile(
    file: Buffer,
    filename: string,
    contentType: string,
    folder: string = 'uploads',
  ): Promise<string> {
    const safeName = (filename || 'file').replace(/[^a-zA-Z0-9._-]/g, '_');
    const key = `${folder}/${Date.now()}-${uuidv4()}-${safeName}`;

    if (!this.isReady) {
      this.logger.log(`[MOCK STORAGE] File "uploaded": ${key}`);
      return key;
    }

    try {
      await this.s3
        .upload({
          Bucket: this.bucketName,
          Key: key,
          Body: file,
          ContentType: contentType,
        })
        .promise();
      this.logger.log(`File uploaded: ${key}`);
      return key;
    } catch (error: any) {
      this.logger.error(`Storage upload failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Delete a file. Accepts either a stored KEY or a legacy full URL.
   */
  async deleteFile(keyOrUrl: string): Promise<boolean> {
    if (!keyOrUrl) return false;
    if (!this.isReady) {
      this.logger.log(`[MOCK STORAGE] File deleted: ${keyOrUrl}`);
      return true;
    }

    const key = this.toKey(keyOrUrl);
    if (!key) {
      this.logger.error('Invalid file reference for delete');
      return false;
    }

    try {
      await this.s3.deleteObject({ Bucket: this.bucketName, Key: key }).promise();
      this.logger.log(`File deleted: ${key}`);
      return true;
    } catch (error: any) {
      this.logger.error(`Storage delete failed: ${error.message}`);
      return false;
    }
  }

  /**
   * Convert a stored value to a viewable URL.
   * - empty            → returned as-is
   * - legacy http(s)   → returned unchanged (old public S3 rows)
   * - object key       → short-lived presigned GET URL
   */
  async getSignedUrl(keyOrUrl: string | null | undefined, expiresIn?: number): Promise<string | null> {
    if (!keyOrUrl) return keyOrUrl ?? null;
    if (/^https?:\/\//i.test(keyOrUrl)) return keyOrUrl; // legacy full URL
    if (!this.isReady) return keyOrUrl;

    try {
      return await this.s3.getSignedUrlPromise('getObject', {
        Bucket: this.bucketName,
        Key: keyOrUrl,
        Expires: expiresIn ?? this.defaultExpiry,
      });
    } catch (error: any) {
      this.logger.error(`Failed to presign "${keyOrUrl}": ${error.message}`);
      return null;
    }
  }

  /**
   * Presign several values at once. Returns a new object with the same keys,
   * each value replaced by its viewable URL. Handy for document field sets.
   */
  async signFields<T extends Record<string, string | null | undefined>>(
    fields: T,
    expiresIn?: number,
  ): Promise<Record<keyof T, string | null>> {
    const entries = await Promise.all(
      (Object.keys(fields) as (keyof T)[]).map(async (k) => {
        const signed = await this.getSignedUrl(fields[k] as string, expiresIn);
        return [k, signed] as const;
      }),
    );
    return entries.reduce((acc, [k, v]) => {
      acc[k] = v;
      return acc;
    }, {} as Record<keyof T, string | null>);
  }

  /** Extract the object key from a stored key or legacy full URL. */
  private toKey(keyOrUrl: string): string {
    if (!/^https?:\/\//i.test(keyOrUrl)) return keyOrUrl; // already a key
    // Path-style (R2 / some S3): https://host/<bucket>/<key>
    const afterBucket = keyOrUrl.split(`${this.bucketName}/`)[1];
    if (afterBucket) return afterBucket.split('?')[0];
    // Virtual-hosted S3: https://<bucket>.s3.<region>.amazonaws.com/<key>
    try {
      const u = new URL(keyOrUrl);
      return u.pathname.replace(/^\/+/, '');
    } catch {
      return '';
    }
  }
}
