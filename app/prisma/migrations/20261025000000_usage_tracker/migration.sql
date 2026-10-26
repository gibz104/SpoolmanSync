-- Re-runnable (IF NOT EXISTS), so an upgrade interrupted part way can be retried.
-- CreateTable
CREATE TABLE IF NOT EXISTS "PrintSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "printer" TEXT NOT NULL,
    "name" TEXT,
    "startedAt" DATETIME NOT NULL,
    "endedAt" DATETIME,
    "outcome" TEXT,
    "settled" BOOLEAN NOT NULL DEFAULT false,
    "attention" TEXT,
    "state" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "UsageDeduction" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "trayKey" TEXT NOT NULL,
    "spoolId" INTEGER NOT NULL,
    "amount" REAL NOT NULL,
    "grams" REAL NOT NULL,
    "status" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "UsageDeduction_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "PrintSession" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PrintSession_printer_endedAt_idx" ON "PrintSession"("printer", "endedAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PrintSession_settled_idx" ON "PrintSession"("settled");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "UsageDeduction_sessionId_idx" ON "UsageDeduction"("sessionId");

