import {
  S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

let cachedClient: S3Client | undefined;

export function isStorageConfigured() {
  return ["S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "S3_ENDPOINT", "S3_PUBLIC_BASE_URL"]
    .every((key) => Boolean(process.env[key]));
}

function storageConfig() {
  const required = ["S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "S3_ENDPOINT", "S3_PUBLIC_BASE_URL"] as const;
  for (const key of required) {
    if (!process.env[key]) throw new Error(`${key} is required for object storage.`);
  }
  const endpoint = new URL(process.env.S3_ENDPOINT!);
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || (process.env.NODE_ENV === "production" && endpoint.protocol !== "https:")) {
    throw new Error("S3_ENDPOINT must be a credential-free URL and use HTTPS in production.");
  }
  if (!cachedClient) {
    cachedClient = new S3Client({
      region: process.env.S3_REGION || "auto",
      endpoint: process.env.S3_ENDPOINT,
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY_ID!,
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
      },
    });
  }
  return { client: cachedClient, bucket: process.env.S3_BUCKET! };
}

export async function putObject(
  key: string,
  body: Buffer,
  contentType: string,
  cacheControl = "private, no-store",
) {
  const { client, bucket } = storageConfig();
  await client.send(new PutObjectCommand({
    Bucket: bucket, Key: key, Body: body, ContentType: contentType, CacheControl: cacheControl,
  }));
}

export async function signedGetUrl(key: string, expiresIn = 900) {
  const { client, bucket } = storageConfig();
  const boundedExpiry = Math.min(900, Math.max(60, Math.floor(expiresIn)));
  return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: boundedExpiry });
}

export function publicAssetUrl(key: string) {
  const base = process.env.S3_PUBLIC_BASE_URL;
  if (!base) throw new Error("S3_PUBLIC_BASE_URL must point to the CDN/public bucket origin.");
  const segments = key.split("/");
  if (!key || key.startsWith("/") || key.includes("\\") || segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("Public asset keys must be relative object paths.");
  }
  const parsed = new URL(base);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("S3_PUBLIC_BASE_URL must be an HTTPS base URL without credentials or query parameters.");
  }
  const prefix = `${parsed.origin}${parsed.pathname.replace(/\/$/, "")}`;
  return `${prefix}/${key.split("/").map(encodeURIComponent).join("/")}`;
}

export async function deleteObject(key: string) {
  const { client, bucket } = storageConfig();
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}
