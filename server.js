// server.js
require("dotenv").config();
const express = require("express");
const crypto = require("crypto");
const fetch = require("node-fetch"); // npm install node-fetch@2

const app = express();

// ---------------- CONFIG ----------------

const PORT = process.env.PORT || 3000;

// WebStock config
const WEBSTOCK_BASE_URL = "https://altena.webstock.nl/WSApp/api/v1";
const WEBSTOCK_USER = process.env.WEBSTOCK_USER;
const WEBSTOCK_PASS = process.env.WEBSTOCK_PASS;
const WEBSTOCK_WAREHOUSE = "Test";         // Test-magazijn
const WEBSTOCK_ORDER_PREFIX = "GWT";       // Prefix voor SalesOrderNumber

// Hoofdklant in WebStock (beatbox-leverancier)
const WEBSTOCK_MAIN_CUSTOMER_NUMBER = "Cust001266";
const WEBSTOCK_MAIN_CUSTOMER_NAME = "GWT-SBG BV";

// Shopify webhook secret (Admin → Meldingen → Webhooks)
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;

// Simpele set om te voorkomen dat we dezelfde order meerdere keren pushen
const sentOrders = new Set();

// ---------------- PRODUCT MAPPING (TITEL → EAN) ----------------
//
// We gebruiken EAN als ArticleNumber in WebStock.
//

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

  // Fallback als er geen match is
  return {
    articleNumber: item.sku || item.title || "UNKNOWN",
    ean: "",
  };
}

// ---------------- HELPERS ----------------

// HMAC-check voor Shopify webhooks
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

// Helper om straat + huisnummer uit één string te halen
// Voorbeelden die goed gaan:
// "Wim Rotherlaan 25"      -> straat="Wim Rotherlaan", nr="25", toevoeging=""
// "Hoofdstraat 12A"        -> straat="Hoofdstraat", nr="12", toevoeging="A"
// "Kerklaan 10-3"          -> straat="Kerklaan", nr="10", toevoeging="-3"
function splitStreetAndHouse(address) {
  if (!address) {
    return {
      street: "",
      houseNumber: "",
      houseNumberAddition: "",
    };
  }

  const trimmed = String(address).trim();

  const match = trimmed.match(/^(.+?)\s+(\d{1,5})([A-Za-z0-9\-\/]*)\s*$/);

  if (!match) {
    // Als we niets herkennen: alles in straat, geen huisnummer
    return {
      street: trimmed,
      houseNumber: "",
      houseNumberAddition: "",
    };
  }

  const street = match[1].trim();
  const houseNumber = match[2].trim();
  const houseNumberAddition = (match[3] || "").trim();

  return {
    street,
    houseNumber,
    houseNumberAddition,
  };
}

// Eén line item uit Shopify → één orderregel in WebStock
function mapLineItemToWebStockLine(item) {
  const { articleNumber, ean } = resolveArticleFromItem(item);

  return {
    SalesOrderLineExternId: 0,
    SalesOrderLineExternGuid: "",
    ArticleId: 0,
    ArticleExternId: 0,
    ArticleExternGuid: "",
    ArticleNumber: articleNumber, // EAN als artikelnummer
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

// Hele Shopify order → WebStock SalesOrder payload
function buildWebStockOrderFromShopify(order) {
  const shipping = order.shipping_address || {};
  const customer = order.customer || {};

  // Eindklant (ontvanger) uit Shopify
  const endCustomerName =
    shipping.company ||
    `${shipping.first_name || ""} ${shipping.last_name || ""}`.trim() ||
    shipping.name ||
    "";
  const endCustomerPhone = shipping.phone || order.phone || "";
  const endCustomerEmail = order.email || order.contact_email || "";

  // Straat + huisnummer uit address1 halen
  const {
    street: street2,
    houseNumber: houseNo2,
    houseNumberAddition: houseAddParsed2,
  } = splitStreetAndHouse(shipping.address1 || "");

  // Landcode (ISO), bv. "NL", "BE"
  const countryCode2 = (shipping.country_code || "").toString().toUpperCase();

  // Eventuele extra toevoeging uit address2 – vaak verdieping / unit
  const houseAddition2 = shipping.address2 || houseAddParsed2;

  // Shopify ordernummer met prefix
  const finalOrderNumber = `${WEBSTOCK_ORDER_PREFIX}${order.order_number}`;

  return {
    // Externe referenties
    SalesOrderExternId: order.id,
    SalesOrderExternGuid: order.admin_graphql_api_id || "",
    SalesOrderExternParentId: 0,

    // Orderheader
    SalesOrderNumber: finalOrderNumber,
    Status: 10, // "Nieuw"

    // HOOFDKLANT = GWT-SBG BV
    CustomerId: 0,
    CustomerNumber: WEBSTOCK_MAIN_CUSTOMER_NUMBER,
    CustomerName: WEBSTOCK_MAIN_CUSTOMER_NAME,
    CustomerContact: "", // eventueel contactpersoon bij GWT-SBG, nu leeg
    CustomerEmail: "",   // eventueel facturatie e-mail, nu leeg

    ProjectName: "",
    ProjectDescription: "",
    HandlingType: "",
    HandlingDate: null,
    ReadyDate: null,

    CustomerReference: order.name, // bv. "#BB_1021"
    SalesOrderDescription: `Shopify order ${order.name}`,

    DeliveryTerms: "",
    ShippingDetails: "",
    SalesOrderDocuments: "",

    // Address 1: leeg laten → WebStock kan standaardadres klant gebruiken
    AddressContactPerson1: "",
    AddressAttention1: "",
    AddressStreet1: "",
    AddressHouseNumber1: "",
    AddressHouseNumberAddition1: "",
    AddressZipcode1: "",
    AddressCity1: "",
    AddressCountry1: "",
    AddressPhonenumber1: "",
    AddressEmail1: "",

    // Address 2: EINDKLANT / ONTVANGER UIT SHOPIFY (afwijkend afleveradres)
    Address2Name: endCustomerName,          // Naam / bedrijfsnaam
    AddressContactPerson2: endCustomerName, // Contactpersoon
    AddressAttention2: "",
    AddressStreet2: street2,                      // alleen straat
    AddressHouseNumber2: houseNo2,               // alleen huisnummer
    AddressHouseNumberAddition2: houseAddition2, // toevoeging / address2
    AddressZipcode2: shipping.zip || "",
    AddressCity2: shipping.city || "",
    AddressCountry2: countryCode2,               // landcode, bv. "NL", "BE"
    AddressPhonenumber2: endCustomerPhone,
    AddressEmail2: endCustomerEmail,

    WareHouse: WEBSTOCK_WAREHOUSE,

    // Orderregels
    OrderLines: (order.line_items || []).map(mapLineItemToWebStockLine),
  };
}

// Call naar WebStock
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

// ---------------- ROUTES ----------------

// Healthcheck
app.get("/", (req, res) => {
  res.json({ ok: true, service: "Shopify → WebStock", time: new Date() });
});

// Webhook: orders-updated
// → wordt aangeroepen bij "Updaten van bestelling" in Shopify
app.post(
  "/webhooks/shopify/orders-updated",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const hmacHeader = req.get("X-Shopify-Hmac-Sha256");
    const rawBody = req.body; // Buffer

    // 1) HMAC check
    if (!verifyShopifyHmac(rawBody, hmacHeader)) {
      console.warn("❌ Ongeldige Shopify webhook (orders-updated)");
      return res.status(401).send("Unauthorized");
    }

    // 2) Parse JSON
    let order;
    try {
      order = JSON.parse(rawBody.toString());
    } catch (err) {
      console.error("❌ JSON parse error:", err);
      return res.status(400).send("Invalid JSON");
    }

    console.log("📦 Webhook ontvangen voor order:", order.name);
    console.log("🔎 fulfillment_status:", order.fulfillment_status);
    console.log("🔎 financial_status:", order.financial_status);
    console.log("🔎 closed_at:", order.closed_at);

    // 3) Alleen triggeren als fulfillment echt "fulfilled" is
    const isFulfilled = order.fulfillment_status === "fulfilled";

    if (!isFulfilled) {
      console.log(
        "ℹ️ Order fulfillment is niet 'fulfilled' → geen WebStock push."
      );
      return res.status(200).send("No action");
    }

    // 3b) Check: hebben we deze order al eerder verstuurd?
    if (sentOrders.has(order.id)) {
      console.log(
        "⛔ Order is al eerder naar WebStock verstuurd → sla deze call over."
      );
      return res.status(200).send("Already sent");
    }
    sentOrders.add(order.id);

    // 4) Bouw WebStock-order en stuur
    try {
      const payload = buildWebStockOrderFromShopify(order);
      console.log(
        "🚀 Verstuur naar WebStock:",
        payload.SalesOrderNumber,
        payload.OrderLines.length,
        "regels"
      );

      await sendOrderToWebStock(payload);

      res.status(200).send("Order sent to WebStock (orders-updated)");
    } catch (err) {
      console.error("❌ Fout tijdens WebStock push:", err);
      res.status(500).send("Server error");
    }
  }
);

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server draait op poort ${PORT}`);
});
