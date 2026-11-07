import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";

import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

let client: S3Client | null = null;

function getStorageConfig() {
  const required = [
    "S3_BUCKET",
    "S3_ACCESS_KEY_ID",
    "S3_SECRET_ACCESS_KEY",
    "S3_ENDPOINT",
  ] as const;

  for (const key of required) {
    if (!process.env[key]) {
      throw new Error(
        `${key} is required when object storage is used.`
      );
    }
  }

  return {
    bucket: process.env.S3_BUCKET!,
    endpoint: process.env.S3_ENDPOINT!,
    accessKeyId: process.env.S3_ACCESS_KEY_ID!,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
    region: process.env.S3_REGION || "auto",
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
  };
}

function getStorageClient() {
  const config = getStorageConfig();

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
  const storage = getStorageClient();

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
  const storage = getStorageClient();

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
    throw new Error(
      "S3_PUBLIC_BASE_URL is required when publishing stored assets."
    );
  }

  return `${base.replace(/\/$/, "")}/${key
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
}

export async function deleteObject(key: string) {
  const storage = getStorageClient();

  await storage.client.send(
    new DeleteObjectCommand({
      Bucket: storage.bucket,
      Key: key,
    })
  );
}
