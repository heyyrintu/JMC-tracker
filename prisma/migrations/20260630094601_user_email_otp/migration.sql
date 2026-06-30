-- AlterTable
ALTER TABLE "users" ADD COLUMN     "email" TEXT,
ADD COLUMN     "reset_otp_expires" TIMESTAMP(3),
ADD COLUMN     "reset_otp_hash" TEXT;
