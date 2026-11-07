const mongoose = require("mongoose");

const webhookDeliverySchema = new mongoose.Schema({
  deliveryId: { type: String, required: true, unique: true },
  event: { type: String, required: true },
  action: { type: String, required: true },
  receivedAt: { type: Date, required: true, default: Date.now },
  processedAt: { type: Date, default: null }
}, { timestamps: false, versionKey: false });

webhookDeliverySchema.index({ receivedAt: 1 }, { expireAfterSeconds: 60 * 24 * 60 * 60 });

module.exports = mongoose.models.WebhookDelivery || mongoose.model("WebhookDelivery", webhookDeliverySchema);
