let prisma = null;

function getPrismaClient() {
  if (prisma) return prisma;
  try {
    const { PrismaClient } = require("@prisma/client");
    prisma = new PrismaClient({
      log: process.env.NODE_ENV === "production" ? ["error"] : ["warn", "error"]
    });
    return prisma;
  } catch (error) {
    throw new Error("Prisma client is not installed. Run npm install and npm run db:generate.");
  }
}

async function closePrismaClient() {
  if (prisma) {
    await prisma.$disconnect();
    prisma = null;
  }
}

module.exports = {
  getPrismaClient,
  closePrismaClient
};
