// Same NDJSON handler as npm start. Importing server.js does not open a port.
module.exports = require("../server").handleChat;
