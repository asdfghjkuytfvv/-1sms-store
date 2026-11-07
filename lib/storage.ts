import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";

import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

function getStorageConfig() {
  const bucket = process.env.S3_BUCKET;
  const accessKeyId = process.env.S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
  const endpoint = process.env.S3_ENDPOINT;

  if (!bucket || !accessKeyId || !secretAccessKey || !endpoint) {
    return null;
  }

  return {
    bucket,
    accessKeyId,
    secretAccessKey,
    endpoint,
    region: process.env.S3_REGION || "auto",
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
  };
}

export function isStorageConfigured(): boolean {
  return getStorageConfig() !== null;
}

let client: S3Client | null = null;

function getClient() {
  const config = getStorageConfig();

  if (!config) {
    throw new Error("S3 storage is not configured.");
  }

  if (!client) {
    client = new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      forcePathStyle: config.forcePathStyle,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }

  return {
    client,
    bucket: config.bucket,
  };
}

export async function putObject(
  key: string,
  body: Buffer,
  contentType: string
) {
  const storage = getClient();

  await storage.client.send(
    new PutObjectCommand({
      Bucket: storage.bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
      CacheControl: "public, max-age=31536000, immutable",
    })
  );
}

export async function signedGetUrl(
  key: string,
  expiresIn = 3600
) {
  const storage = getClient();

  return getSignedUrl(
    storage.client,
    new GetObjectCommand({
      Bucket: storage.bucket,
      Key: key,
    }),
    { expiresIn }
  );
}

export function publicAssetUrl(key: string) {
  const base = process.env.S3_PUBLIC_BASE_URL;

  if (!base) {
    throw new Error("S3_PUBLIC_BASE_URL is not configured.");
  }

  return `${base.replace(/\/$/, "")}/${key
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
}

export async function deleteObject(key: string) {
  const storage = getClient();

  await storage.client.send(
    new DeleteObjectCommand({
      Bucket: storage.bucket,
      Key: key,
    })
  );
}
