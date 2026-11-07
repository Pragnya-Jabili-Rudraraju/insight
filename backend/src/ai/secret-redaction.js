const { redactSourceText } = require("../reviews/finding-validator");

function redactSource(source) {
  return redactSourceText(source);
}

module.exports = { redactSource };
