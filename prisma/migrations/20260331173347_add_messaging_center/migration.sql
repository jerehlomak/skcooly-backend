-- CreateTable
CREATE TABLE "SchoolConversation" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "subject" TEXT NOT NULL DEFAULT 'General Inquiry',
    "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isClosed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SchoolConversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SchoolMessage" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "senderType" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "senderName" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SchoolMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SchoolConversation_schoolId_idx" ON "SchoolConversation"("schoolId");

-- CreateIndex
CREATE INDEX "SchoolConversation_lastMessageAt_idx" ON "SchoolConversation"("lastMessageAt" DESC);

-- CreateIndex
CREATE INDEX "SchoolMessage_conversationId_idx" ON "SchoolMessage"("conversationId");

-- CreateIndex
CREATE INDEX "SchoolMessage_conversationId_createdAt_idx" ON "SchoolMessage"("conversationId", "createdAt" ASC);

-- AddForeignKey
ALTER TABLE "SchoolConversation" ADD CONSTRAINT "SchoolConversation_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SchoolMessage" ADD CONSTRAINT "SchoolMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "SchoolConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
