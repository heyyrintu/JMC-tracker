-- AlterTable
ALTER TABLE "sessions" ADD COLUMN     "expires_at" TIMESTAMP(3),
ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'web';
