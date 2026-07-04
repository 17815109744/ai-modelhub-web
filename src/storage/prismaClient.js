let prisma = null;

function runtimeDatabaseUrl() {
  return process.env.PRISMA_DATABASE_URL || process.env.DIRECT_URL || process.env.DATABASE_URL || "";
}

function getPrismaClient() {
  if (prisma) return prisma;
  try {
    const { PrismaClient } = require("@prisma/client");
    const datasourceUrl = runtimeDatabaseUrl();
    prisma = new PrismaClient({
      log: process.env.NODE_ENV === "production" ? ["error"] : ["warn", "error"],
      ...(datasourceUrl
        ? {
            datasources: {
              db: {
                url: datasourceUrl
              }
            }
          }
        : {})
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
  closePrismaClient,
  runtimeDatabaseUrl
};
