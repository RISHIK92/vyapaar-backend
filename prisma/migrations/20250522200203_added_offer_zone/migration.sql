-- CreateTable
CREATE TABLE "OfferZone" (
    "id" TEXT NOT NULL,
    "vendorName" TEXT NOT NULL,
    "discount" TEXT NOT NULL,
    "promoCode" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "validUntil" TEXT NOT NULL,
    "rating" DOUBLE PRECISION NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OfferZone_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OfferZone_isActive_idx" ON "OfferZone"("isActive");

-- CreateIndex
CREATE INDEX "OfferZone_validUntil_idx" ON "OfferZone"("validUntil");
