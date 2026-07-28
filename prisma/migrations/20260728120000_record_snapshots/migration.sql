-- CreateTable
CREATE TABLE "record_snapshots" (
    "id" SERIAL NOT NULL,
    "entity" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "reason" TEXT NOT NULL,
    "taken_by" INTEGER,
    "taken_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "restored_at" TIMESTAMP(3),
    "restored_by" INTEGER,

    CONSTRAINT "record_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_record_snapshots_entity" ON "record_snapshots"("entity", "taken_at");
