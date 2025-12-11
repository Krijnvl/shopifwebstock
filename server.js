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
const WEBSTOCK_ORDER_PREFIX = "GWT";

const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;
const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN; // bv. beatbox-binc.myshopify.com
const SHOPIFY_ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;

// ---------------- PRODUCT MAPPING (TITEL → EAN) ----------------

const TITLE_TO_EAN_MAP = {
  "fruit punch": "8720892642738",
  "blue razzberry": "8720892642714",
  "juicy mango": "8720892642752",
  "orange blast": "8720892642776",
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

  // fallback
  return {
    articleNumber: item.sku || item.title || "UNKNOWN",
    ean: "",
  };
}

// ---------------- HELPERS ----------------

function verifyShopifyHmac(rawBody, hmacHeader) {
  if (!SHOPIFY_WEBHOOK_SECRET || !hmacHeader) return false;

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

function mapLineItemToWebStockLine(item) {
  const { articleNumber, ean } = resolveArticleFromItem(item);

  return {
    SalesOrderLineExternId: 0,
    SalesOrderLineExternGuid: "",
    ArticleId: 0,
    ArticleExternId: 0,
    ArticleExternGuid: "",
    ArticleNumber: articleNumber,
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
    Status: 10,

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
    throw new Error(`WebStock ${res.status}: ${text}`);
  }

  console.log("✅ WebStock OK:", text);
  return text;
}

// Shopify Admin API: order ophalen op basis van ID
async function fetchShopifyOrder(orderId) {
  if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_ADMIN_TOKEN) {
    throw new Error("SHOPIFY_STORE_DOMAIN of SHOPIFY_ADMIN_TOKEN ontbreekt");
  }

  const url = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/2025-01/orders/${orderId}.json`;

  const res = await fetch(url, {
    method: "GET",
    headers: {
      "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN,
      "Content-Type": "application/json",
    },
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("❌ Fout bij ophalen order uit Shopify:", res.status, text);
    throw new Error(`Shopify ${res.status}: ${text}`);
  }

  const data = await res.json();
  return data.order;
}

// ---------------- ROUTES ----------------

// Healthcheck
app.get("/", (req, res) => {
  res.json({ ok: true, service: "Shopify → WebStock", time: new Date() });
});

// Bestaande orders-updated webhook (mag blijven staan)
app.post(
  "/webhooks/shopify/orders-updated",
  express.raw({ type: "application/json" }),
  (req, res) => {
    const hmacHeader = req.get("X-Shopify-Hmac-Sha256");
    const rawBody = req.body;

    if (!verifyShopifyHmac(rawBody, hmacHeader)) {
      console.warn("❌ Ongeldige Shopify webhook (orders-updated)");
      return res.status(401).send("Unauthorized");
    }

    let order;
    try {
      order = JSON.parse(rawBody.toString());
    } catch (err) {
      console.error("❌ JSON parse error:", err);
      return res.status(400).send("Invalid JSON");
    }

    console.log("📦 (orders-updated) Webhook ontvangen voor order:", order.name);
    console.log("ℹ️ Deze route stuurt niks door naar WebStock (alleen logging).");
    res.status(200).send("OK");
  }
);

// NIEUW: fulfilment-update webhook
app.post(
  "/webhooks/shopify/fulfillments-update",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const hmacHeader = req.get("X-Shopify-Hmac-Sha256");
    const rawBody = req.body;

    if (!verifyShopifyHmac(rawBody, hmacHeader)) {
      console.warn("❌ Ongeldige Shopify webhook (fulfillments-update)");
      return res.status(401).send("Unauthorized");
    }

    let fulfillment;
    try {
      fulfillment = JSON.parse(rawBody.toString());
    } catch (err) {
      console.error("❌ JSON parse error:", err);
      return res.status(400).send("Invalid JSON");
    }

    console.log("📦 Fulfilment-webhook ontvangen:", fulfillment.id);

    const status = fulfillment.status;
    console.log("🔎 Fulfilment status:", status);

    const isInExecution =
      status === "in_progress" ||
      status === "open" ||
      status === "pending";

    if (!isInExecution) {
      console.log("ℹ️ Fulfilment is niet 'in uitvoering' → geen WebStock push.");
      return res.status(200).send("No action");
    }

    try {
      const orderId = fulfillment.order_id;
      console.log("🔎 Haal order op uit Shopify:", orderId);

      const order = await fetchShopifyOrder(orderId);

      console.log("🧾 Order gevonden:", order.name);

      const payload = buildWebStockOrderFromShopify(order);
      console.log(
        "🚀 Verstuur naar WebStock:",
        payload.SalesOrderNumber,
        payload.OrderLines.length,
        "regels"
      );

      await sendOrderToWebStock(payload);

      res.status(200).send("Order sent to WebStock via fulfilment");
    } catch (err) {
      console.error("❌ Fout in fulfilment-handler:", err);
      res.status(500).send("Server error");
    }
  }
);

app.listen(PORT, () => {
  console.log(`🚀 Server draait op poort ${PORT}`);
});
