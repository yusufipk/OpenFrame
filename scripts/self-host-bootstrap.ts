import 'dotenv/config';
import { ensureR2BucketExists, R2_BUCKET_NAME } from '@/lib/r2';

const shouldCreateBucket = /^(1|true|yes|on)$/i.test(process.env.SELF_HOSTED_AUTO_CREATE_BUCKET ?? '');

async function main() {
  if (!shouldCreateBucket) {
    console.log('Skipping self-host bucket bootstrap');
    return;
  }

  console.log(`Ensuring object storage bucket exists: ${R2_BUCKET_NAME}`);
  await ensureR2BucketExists();
  console.log(`Bucket is ready: ${R2_BUCKET_NAME}`);
}

main().catch((error) => {
  console.error('Self-host bootstrap failed:', error);
  process.exit(1);
});
