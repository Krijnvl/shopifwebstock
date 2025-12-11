// server.js
require("dotenv").config();
const express = require("express");
const crypto = require("crypto");
const fetch = require("node-fetch"); // npm install node-fetch@2

const app = express();

// ---------------- CONFIG ----------------

const PORT = process.env.PORT || 3000;

const WEBSTOCK_BASE_URL = "https://altena.webstock.nl/wsapp/api/v1";
const WEBSTOCK_USER = process.env.WEBSTOCK_USER;
const WEBSTOCK_PASS = process.env.WEBSTOCK_PASS;
const WEBSTOCK_WAREHOUSE = "Test";
const WEBSTOCK_ORDER_PREFIX = "GWT"; // altijd voor ordernummer

const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;

// ---------------- PRODUCT MAPPING (TITEL → EAN) ----------------
//
// EAN = artikelnummer = WebStock ArticleNumber
//
const TITLE_TO_EAN_MAP = {
  "fruit punch": "8720892642738",
  "blue razzberry": "8720892642714",
  "juicy mango": "8720892642752",
  "orange blast": "8720892642776", // JUISTE EAN
};

function normalizeTitle(title) {
  if (!title) return "";
  return String(title).trim().toLowerCase();
}

function resolveArticleFromItem(item) {
  const normalized = normalizeTitle(item.title);
  const ean = TITLE_TO_EAN_MAP[normalized];

  if (ean) {
    return {
      articleNumber: ean,
      ean: ean,
    };
  }

  // fallback als product niet gevonden wordt
  return {
    articleNumber: item.sku || item.title || "UNKNOWN",
    ean: "",
  };
}

// ---------------- HELPERS ----------------

// Shopify HMAC verificatie
function verifyShopifyHmac(rawBody, hmacHeader) {
  const digest = crypto
    .createHmac("sha256", SHOPIFY_WEBHOOK_SECRET)
    .update(rawBody, "utf8")
    .digest("base64");

  try {
    return crypto.timingSafeEqual(
      Buffer.from(digest, "utf8"),
      Buffer.from(hmacHeader, "utf8")
    );
  } catch {
    return false;
  }
}

// Opbouw van WebStock orderregels vanuit Shopify items
function mapLineItemToWebStockLine(item) {
  const { articleNumber, ean } = resolveArticleFromItem(item);

  return {
    SalesOrderLineExternId: 0,
    SalesOrderLineExternGuid: "",
    ArticleId: 0,
    ArticleExternId: 0,
    ArticleExternGuid: "",
    ArticleNumber: articleNumber, // EAN = artikelnummer
    Eancode: ean,
    PackagingUnit: "st",
    PackagingQuantity: 1,
    ProductGroup: "",
    ProductName: item.title || "",
    ProductDescription: item.variant_title || item.title || "",
    QuantityOrdered: item.quantity || 0,
    QuantityDelivered: 0,
    PricePerArticle: parseFloat(item.price || 0),
    Description: "",
    LotId: 0,
    LotName: "",
    LotDescription: "",
    LotBestBeforeDate: "",
  };
}

// Bouw volledige WebStock order vanuit Shopify order
function buildWebStockOrderFromShopify(order) {
  const shipping = order.shipping_address || {};
  const customer = order.customer || {};

  const finalOrderNumber = `${WEBSTOCK_ORDER_PREFIX}${order.order_number}`;
  const customerName =
    `${customer.first_name || ""} ${customer.last_name || ""}`.trim() ||
    shipping.name ||
    order.name;

  return {
    SalesOrderExternId: order.id,
    SalesOrderExternGuid: order.admin_graphql_api_id || "",
    SalesOrderExternParentId: 0,

    SalesOrderNumber: finalOrderNumber,
    Status: 10, // New

    CustomerId: 0,
    CustomerNumber: customer.id ? String(customer.id) : "",
    CustomerName: customerName,
    CustomerContact: shipping.name || "",
    CustomerEmail: order.email || order.contact_email || "",

    ProjectName: "",
    ProjectDescription: "",

    HandlingType: "",
    HandlingDate: null,
    ReadyDate: null,

    CustomerReference: order.name,
    SalesOrderDescription: `Shopify order ${order.name}`,

    DeliveryTerms: "",
    ShippingDetails: "",
    SalesOrderDocuments: "",

    AddressContactPerson1: shipping.name || "",
    AddressAttention1: "",
    AddressStreet1: shipping.address1 || "",
    AddressHouseNumber1: "",
    AddressHouseNumberAddition1: "",
    AddressZipcode1: shipping.zip || "",
    AddressCity1: shipping.city || "",
    AddressCountry1: shipping.country || "",
    AddressPhonenumber1: shipping.phone || order.phone || "",
    AddressEmail1: order.email || order.contact_email || "",

    Address2Name: "",
    AddressContactPerson2: "",
    AddressAttention2: "",
    AddressStreet2: "",
    AddressHouseNumber2: "",
    AddressHouseNumberAddition2: "",
    AddressZipcode2: "",
    AddressCity2: "",
    AddressCountry2: "",
    AddressPhonenumber2: "",
    AddressEmail2: "",

    WareHouse: WEBSTOCK_WAREHOUSE,

    OrderLines: (order.line_items || []).map(mapLineItemToWebStockLine),
  };
}

// WebStock POST call
async function sendOrderToWebStock(orderPayload) {
  const url = `${WEBSTOCK_BASE_URL}/SalesOrders`;

  const auth = Buffer.from(`${WEBSTOCK_USER}:${WEBSTOCK_PASS}`).toString(
    "base64"
  );

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${auth}`,
    },
    body: JSON.stringify(orderPayload),
  });

  const text = await res.text();

  if (!res.ok) {
    console.error("❌ WebStock error:", res.status, text);
    throw new Error(text);
  }

  console.log("✅ WebStock OK:", text);
  return text;
}

// ---------------- ROUTES ----------------

// Health endpoint
app.get("/", (req, res) => {
  res.json({ ok: true, service: "Shopify → WebStock", time: new Date() });
});

// Shopify webhook — RAW body verplicht
app.post(
  "/webhooks/shopify/orders-updated",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const hmacHeader = req.get("X-Shopify-Hmac-Sha256");

    const rawBody = req.body;

    if (!verifyShopifyHmac(rawBody, hmacHeader)) {
      console.warn("❌ Ongeldige Shopify Webhook (HMAC mismatch)");
      return res.status(401).send("Unauthorized");
    }

    let order;
    try {
      order = JSON.parse(rawBody.toString());
    } catch (err) {
      console.error("❌ JSON parse error:", err);
      return res.status(400).send("Invalid JSON");
    }

    console.log("📦 Webhook ontvangen voor order:", order.name);

    // Check op fulfillment status “in uitvoering”
    const status = order.fulfillment_status;
    const hasInProgress =
      Array.isArray(order.fulfillments) &&
      order.fulfillments.some((f) => f.status === "in_progress");

    if (status !== "in_progress" && !hasInProgress) {
      console.log("ℹ️ Order is niet in uitvoering → geen push.");
      return res.status(200).send("No action");
    }

    try {
      const payload = buildWebStockOrderFromShopify(order);

      console.log(
        "🚀 Verstuur naar WebStock:",
        payload.SalesOrderNumber,
        payload.OrderLines.length,
        "regels"
      );

      await sendOrderToWebStock(payload);

      res.status(200).send("Order sent to WebStock");
    } catch (err) {
      console.error("❌ Fout tijdens WebStock push:", err);
      res.status(500).send("Server error");
    }
  }
);

// Start server
app.listen(PORT, () =>
  console.log(`🚀 Server draait op poort ${PORT}`)
);
