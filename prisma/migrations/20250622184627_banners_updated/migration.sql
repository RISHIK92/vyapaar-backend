-- AlterTable
ALTER TABLE "AdminBanner" ADD COLUMN     "youtubeUrl" TEXT,
ALTER COLUMN "Image" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Banner" ADD COLUMN     "youtubeUrl" TEXT,
ALTER COLUMN "Image" DROP NOT NULL;

-- AlterTable
ALTER TABLE "BottomBanner" ADD COLUMN     "youtubeUrl" TEXT,
ALTER COLUMN "Image" DROP NOT NULL;

-- AlterTable
ALTER TABLE "CategoryBanner" ADD COLUMN     "youtubeUrl" TEXT,
ALTER COLUMN "Image" DROP NOT NULL;

-- AlterTable
ALTER TABLE "MiddleBanner" ADD COLUMN     "youtubeUrl" TEXT,
ALTER COLUMN "Image" DROP NOT NULL;
