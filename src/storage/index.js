const { getConfig } = require("../config");
const prismaStore = require("./prismaStore");

function getStore() {
  const config = getConfig();
  if (config.dataBackend === "prisma") {
    return {
      backend: "prisma",
      ...prismaStore
    };
  }
  return {
    backend: "local"
  };
}

module.exports = {
  getStore
};
