require("dotenv").config();

const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const app = express();

/* =========================================================
   CONFIG
========================================================= */

const PORT = Number(process.env.PORT || 3000);

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";

const CJ_API_KEY = process.env.CJ_API_KEY || "";

const CJ_ACCESS_TOKEN = process.env.CJ_ACCESS_TOKEN || "";

const CJ_API_BASE =
  process.env.CJ_API_BASE ||
  "https://developers.cjdropshipping.com/api2.0/v1";

/*
  CJ_PAGE_SIZE = products requested from CJ per API page.
  100 is the normal target here.
*/
const CJ_PAGE_SIZE = Math.max(
  1,
  Number(process.env.CJ_PAGE_SIZE || 100)
);

/*
  Maximum number of CJ API pages to synchronize.

  Current CJ catalog reports approximately:
  60 pages x 100 products = 6000 products.
*/
const CJ_SYNC_PAGES = Math.max(
  1,
  Number(process.env.CJ_SYNC_PAGES || 60)
);

const MIN_PRODUCT_STOCK = Math.max(
  0,
  Number(process.env.MIN_PRODUCT_STOCK || 0)
);

const GLOBIRA_MARKUP_PERCENT = Number(
  process.env.GLOBIRA_MARKUP_PERCENT || 60
);

const PRODUCT_SYNC_INTERVAL_MINUTES = Math.max(
  1,
  Number(process.env.PRODUCT_SYNC_INTERVAL_MINUTES || 30)
);

/*
  GLOBIRA is a global website.

  USD is only the base/fallback currency.
  Customer-facing localization can be added later.
*/
const DEFAULT_CURRENCY =
  process.env.DEFAULT_CURRENCY || "USD";

/*
  Normal delay between CJ product-list requests.

  CJ currently allows approximately 1 request/second,
  so 2000ms provides additional safety.
*/
const CJ_PAGE_DELAY_MS = Math.max(
  1100,
  Number(process.env.CJ_PAGE_DELAY_MS || 2000)
);

/*
  Automatic retry configuration for CJ rate limits.
*/
const CJ_MAX_429_RETRIES = Math.max(
  1,
  Number(process.env.CJ_MAX_429_RETRIES || 5)
);

const CJ_429_BASE_DELAY_MS = Math.max(
  2000,
  Number(process.env.CJ_429_BASE_DELAY_MS || 5000)
);

/* =========================================================
   PATHS
========================================================= */

const ORDERS_FILE = path.join(
  __dirname,
  ".globira-orders.json"
);

const CATALOG_FILE = path.join(
  __dirname,
  ".globira-catalog.json"
);

/* =========================================================
   EXPRESS
========================================================= */

app.use(
  express.json({
    limit: "2mb"
  })
);

app.use(
  express.urlencoded({
    extended: true
  })
);

/* =========================================================
   JSON HELPERS
========================================================= */

function readJSON(file, fallback) {
  try {
    if (!fs.existsSync(file)) {
      return fallback;
    }

    const raw = fs.readFileSync(
      file,
      "utf8"
    );

    if (!raw.trim()) {
      return fallback;
    }

    return JSON.parse(raw);
  } catch (error) {
    console.error(
      `Failed to read JSON file ${file}:`,
      error.message
    );

    return fallback;
  }
}

function writeJSON(file, data) {
  try {
    fs.writeFileSync(
      file,
      JSON.stringify(data, null, 2),
      "utf8"
    );

    return true;
  } catch (error) {
    console.error(
      `Failed to write JSON file ${file}:`,
      error.message
    );

    return false;
  }
}

/* =========================================================
   SAFE HELPERS
========================================================= */

function safeString(value) {
  if (
    value === undefined ||
    value === null
  ) {
    return "";
  }

  return String(value).trim();
}

function safeNumber(
  value,
  fallback = 0
) {
  const number = Number(value);

  return Number.isFinite(number)
    ? number
    : fallback;
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (
      value !== undefined &&
      value !== null &&
      safeString(value) !== ""
    ) {
      return value;
    }
  }

  return "";
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function makeId(prefix = "") {
  return (
    prefix +
    crypto
      .randomBytes(12)
      .toString("hex")
  );
}

/* =========================================================
   ORDERS STORAGE
========================================================= */

function loadOrders() {
  const data = readJSON(
    ORDERS_FILE,
    []
  );

  return Array.isArray(data)
    ? data
    : [];
}

function saveOrders(orders) {
  return writeJSON(
    ORDERS_FILE,
    orders
  );
}

/* =========================================================
   CATALOG STORAGE
========================================================= */

function loadCatalog() {
  const data = readJSON(
    CATALOG_FILE,
    {
      products: [],
      meta: {}
    }
  );

  if (
    !data ||
    typeof data !== "object"
  ) {
    return {
      products: [],
      meta: {}
    };
  }

  if (
    !Array.isArray(data.products)
  ) {
    data.products = [];
  }

  if (
    !data.meta ||
    typeof data.meta !== "object"
  ) {
    data.meta = {};
  }

  return data;
}

function saveCatalog(
  products,
  meta = {}
) {
  return writeJSON(
    CATALOG_FILE,
    {
      products,
      meta
    }
  );
}

/* =========================================================
   ADMIN SESSION
========================================================= */

const adminSessions = new Map();

function createAdminSession() {
  const token =
    crypto.randomBytes(32).toString("hex");

  adminSessions.set(token, {
    createdAt: Date.now()
  });

  return token;
}

function getCookie(
  req,
  name
) {
  const cookieHeader =
    req.headers.cookie;

  if (!cookieHeader) {
    return null;
  }

  const cookies =
    cookieHeader.split(";");

  for (const cookie of cookies) {
    const index =
      cookie.indexOf("=");

    if (index === -1) {
      continue;
    }

    const key =
      cookie
        .slice(0, index)
        .trim();

    const value =
      cookie
        .slice(index + 1)
        .trim();

    if (key === name) {
      return decodeURIComponent(
        value
      );
    }
  }

  return null;
}

function requireAdmin(
  req,
  res,
  next
) {
  const token =
    getCookie(
      req,
      "globira_admin_session"
    ) ||
    req.headers[
      "x-admin-token"
    ] ||
    req.headers.authorization?.replace(
      /^Bearer\s+/i,
      ""
    );

  if (
    !token ||
    !adminSessions.has(token)
  ) {
    return res.status(401).json({
      success: false,
      message: "Unauthorized"
    });
  }

  next();
}

/* =========================================================
   COOKIE HELPERS
========================================================= */

function setAdminCookie(
  res,
  token
) {
  const parts = [
    `globira_admin_session=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${60 * 60 * 24}`
  ];

  if (
    process.env.NODE_ENV ===
    "production"
  ) {
    parts.push("Secure");
  }

  res.setHeader(
    "Set-Cookie",
    parts.join("; ")
  );
}

function clearAdminCookie(res) {
  const parts = [
    "globira_admin_session=",
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0"
  ];

  if (
    process.env.NODE_ENV ===
    "production"
  ) {
    parts.push("Secure");
  }

  res.setHeader(
    "Set-Cookie",
    parts.join("; ")
  );
}

/* =========================================================
   CJ AUTHENTICATION
========================================================= */

let cjAccessToken =
  CJ_ACCESS_TOKEN || "";

async function getCJAccessToken(
  forceRefresh = false
) {
  if (
    cjAccessToken &&
    !forceRefresh
  ) {
    return cjAccessToken;
  }

  if (!CJ_API_KEY) {
    throw new Error(
      "CJ_API_KEY is missing from environment variables."
    );
  }

  console.log(
    "CJ authentication: requesting access token..."
  );

  const response =
    await fetch(
      `${CJ_API_BASE}/authentication/getAccessToken`,
      {
        method: "POST",
        headers: {
          "Content-Type":
            "application/json",
          Accept:
            "application/json"
        },
        body: JSON.stringify({
          apiKey: CJ_API_KEY
        })
      }
    );

  const text =
    await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    data = {
      rawText: text
    };
  }

  if (!response.ok) {
    console.error(
      "CJ authentication HTTP error:",
      response.status,
      data
    );

    throw new Error(
      `CJ authentication failed with HTTP ${response.status}`
    );
  }

  /*
    Never print the actual access token
    or refresh token.
  */

  console.log(
    "CJ authentication response:",
    JSON.stringify({
      code: data?.code,
      result: data?.result,
      message: data?.message,
      success: data?.success,
      hasAccessToken:
        Boolean(
          data?.data?.accessToken ||
          data?.data?.access_token ||
          data?.accessToken ||
          data?.access_token
        )
    })
  );

  const token =
    firstNonEmpty(
      data?.data?.accessToken,
      data?.data?.access_token,
      data?.accessToken,
      data?.access_token
    );

  if (!token) {
    throw new Error(
      "CJ authentication succeeded but no access token was found in the response."
    );
  }

  cjAccessToken =
    safeString(token);

  console.log(
    "CJ authentication: access token received."
  );

  return cjAccessToken;
}

/* =========================================================
   CJ REQUEST
========================================================= */

async function cjRequest(
  endpoint,
  options = {},
  retryAuth = true,
  retry429Count = 0
) {
  const token =
    await getCJAccessToken();

  const method =
    options.method || "GET";

  /*
    IMPORTANT:

    CJ requires:

    CJ-Access-Token: <token>

    NOT:

    Authorization: Bearer <token>
  */

  const headers = {
    Accept:
      "application/json",
    ...(options.headers || {}),
    "CJ-Access-Token":
      token
  };

  if (
    options.body &&
    !headers["Content-Type"]
  ) {
    headers["Content-Type"] =
      "application/json";
  }

  const url =
    `${CJ_API_BASE}${endpoint}`;

  console.log(
    `CJ request: ${method} ${url}`
  );

  const response =
    await fetch(url, {
      ...options,
      method,
      headers
    });

  const text =
    await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    data = {
      rawText: text
    };
  }

  /* ========================================================
     CJ RATE LIMIT HANDLING
  ======================================================== */

  if (
    response.status === 429
  ) {
    if (
      retry429Count <
      CJ_MAX_429_RETRIES
    ) {
      /*
        Exponential backoff:

        retry 1 = 5 seconds
        retry 2 = 10 seconds
        retry 3 = 20 seconds
        retry 4 = 40 seconds
        retry 5 = 80 seconds
      */

      const retryDelay =
        CJ_429_BASE_DELAY_MS *
        Math.pow(
          2,
          retry429Count
        );

      console.warn(
        `CJ rate limit (429) on ${endpoint}.`
      );

      console.warn(
        `Waiting ${retryDelay}ms before retry ${retry429Count + 1}/${CJ_MAX_429_RETRIES}...`
      );

      await sleep(
        retryDelay
      );

      return cjRequest(
        endpoint,
        options,
        retryAuth,
        retry429Count + 1
      );
    }

    console.error(
      `CJ rate limit persisted after ${CJ_MAX_429_RETRIES} retries.`
    );

    const error =
      new Error(
        "CJ API rate limit persisted after automatic retries."
      );

    error.status =
      response.status;

    error.data = data;

    throw error;
  }

  /* ========================================================
     AUTHENTICATION RETRY
  ======================================================== */

  if (
    (response.status === 401 ||
      response.status === 403) &&
    retryAuth
  ) {
    console.log(
      "CJ token appears invalid/expired. Refreshing token..."
    );

    cjAccessToken = "";

    await getCJAccessToken(
      true
    );

    return cjRequest(
      endpoint,
      options,
      false,
      retry429Count
    );
  }

  /* ========================================================
     OTHER HTTP ERRORS
  ======================================================== */

  if (!response.ok) {
    console.error(
      "CJ API HTTP ERROR:",
      response.status,
      JSON.stringify(data).slice(
        0,
        3000
      )
    );

    const error =
      new Error(
        `CJ API returned HTTP ${response.status}`
      );

    error.status =
      response.status;

    error.data = data;

    throw error;
  }

  /*
    CJ sometimes returns HTTP 200 while
    code/success indicates an application error.
  */

  if (
    data &&
    typeof data === "object"
  ) {
    if (
      data.success === false ||
      (
        data.code !== undefined &&
        String(data.code) !== "200" &&
        String(data.code) !== "0"
      )
    ) {
      console.error(
        "CJ API application error:",
        JSON.stringify(data).slice(
          0,
          3000
        )
      );

      const error =
        new Error(
          data.message ||
          "CJ API returned an application error."
        );

      error.status =
        response.status;

      error.data = data;

      throw error;
    }
  }

  return data;
}

/* =========================================================
   CJ PRODUCT HELPERS
========================================================= */

function getCJProductId(product) {
  return safeString(
    firstNonEmpty(
      product?.pid,
      product?.productId,
      product?.id,
      product?.product_id,
      product?.productCode
    )
  );
}

/*
  IMPORTANT FIX:

  CJ Product List V2 uses "nameEn"
  for the English product name.
*/
function getCJProductName(product) {
  return safeString(
    firstNonEmpty(
      product?.productName,
      product?.nameEn,
      product?.productNameEn,
      product?.name,
      product?.title,
      product?.product_name,
      product?.productTitle
    )
  );
}

function getCJProductDescription(
  product
) {
  return safeString(
    firstNonEmpty(
      product?.description,
      product?.productDescription,
      product?.desc,
      product?.productDesc,
      product?.descriptionEn,
      product?.productDescriptionEn
    )
  );
}

function getCJProductSku(product) {
  return safeString(
    firstNonEmpty(
      product?.sku,
      product?.productSku,
      product?.productSKU,
      product?.variantSku,
      product?.variants?.[0]?.sku
    )
  );
}

/*
  IMPORTANT FIX:

  CJ Product List V2 commonly provides
  "bigImage".
*/
function getCJProductImage(product) {
  const direct =
    firstNonEmpty(
      product?.productImage,
      product?.bigImage,
      product?.image,
      product?.imageUrl,
      product?.mainImage,
      product?.productImageUrl,
      product?.product_image
    );

  if (direct) {
    return safeString(
      direct
    );
  }

  const images =
    getCJProductImages(
      product
    );

  return images[0] || "";
}

function getCJProductImages(
  product
) {
  const output = [];

  const candidates = [
    product?.productImage,
    product?.bigImage,
    product?.image,
    product?.imageUrl,
    product?.mainImage,
    product?.productImageUrl,
    product?.product_image
  ];

  for (
    const value of candidates
  ) {
    if (
      typeof value === "string"
    ) {
      const parts =
        value
          .split(",")
          .map(
            (item) =>
              item.trim()
          )
          .filter(Boolean);

      output.push(
        ...parts
      );
    }

    if (Array.isArray(value)) {
      output.push(
        ...value
          .map((item) => {
            if (
              typeof item ===
              "string"
            ) {
              return item;
            }

            return firstNonEmpty(
              item?.url,
              item?.imageUrl,
              item?.image
            );
          })
          .filter(Boolean)
      );
    }
  }

  if (
    Array.isArray(
      product?.images
    )
  ) {
    output.push(
      ...product.images
        .map((item) => {
          if (
            typeof item ===
            "string"
          ) {
            return item;
          }

          return firstNonEmpty(
            item?.url,
            item?.imageUrl,
            item?.image
          );
        })
        .filter(Boolean)
    );
  }

  return [
    ...new Set(output)
  ];
}

/*
  IMPORTANT FIX:

  CJ Product List V2 can expose inventory
  through warehouseInventoryNum.
*/
function getCJProductStock(
  product
) {
  const value =
    firstNonEmpty(
      product?.stock,
      product?.inventory,
      product?.totalInventory,
      product?.availableStock,
      product?.warehouseInventoryNum,
      product?.warehouseInventory,
      product?.quantity,
      product?.productStock,
      product?.listedNum
    );

  return Math.max(
    0,
    safeNumber(value, 0)
  );
}

/* =========================================================
   PRICE PARSING
========================================================= */

function parseCJPriceRange(
  product
) {
  const values = [];

  const possibleValues = [
    product?.sellPrice,
    product?.sellingPrice,
    product?.price,
    product?.productPrice,
    product?.salePrice,
    product?.minPrice,
    product?.maxPrice,
    product?.variants?.map?.(
      (variant) =>
        firstNonEmpty(
          variant?.price,
          variant?.sellPrice,
          variant?.sellingPrice
        )
    )
  ];

  function collect(value) {
    if (
      value === undefined ||
      value === null
    ) {
      return;
    }

    if (Array.isArray(value)) {
      for (
        const item of value
      ) {
        collect(item);
      }

      return;
    }

    if (
      typeof value ===
      "number"
    ) {
      if (
        Number.isFinite(value)
      ) {
        values.push(value);
      }

      return;
    }

    if (
      typeof value ===
      "string"
    ) {
      /*
        FIXED REGEX:

        Previous version contained corrupted
        formatting here.
      */
      const matches =
        value.match(
          /\d+(?:\.\d+)?/g
        );

      if (!matches) {
        return;
      }

      for (
        const match of matches
      ) {
        const number =
          Number(match);

        if (
          Number.isFinite(number)
        ) {
          values.push(number);
        }
      }
    }
  }

  for (
    const value of possibleValues
  ) {
    collect(value);
  }

  const cleaned =
    values
      .filter(
        (value) =>
          value >= 0
      )
      .sort(
        (a, b) =>
          a - b
      );

  if (!cleaned.length) {
    return {
      min: 0,
      max: 0,
      raw: ""
    };
  }

  return {
    min: cleaned[0],
    max:
      cleaned[
        cleaned.length - 1
      ],
    raw: safeString(
      firstNonEmpty(
        product?.sellPrice,
        product?.sellingPrice,
        product?.price,
        product?.productPrice,
        product?.salePrice
      )
    )
  };
}

function getCJProductCostInfo(
  product
) {
  const priceRange =
    parseCJPriceRange(
      product
    );

  return {
    min: priceRange.min,
    max: priceRange.max,
    raw: priceRange.raw
  };
}

function getCJProductCost(
  product
) {
  const info =
    getCJProductCostInfo(
      product
    );

  return info.min;
}

/* =========================================================
   CATEGORY HELPERS
========================================================= */

function getCJCategory(product) {
  const direct =
    safeString(
      firstNonEmpty(
        product?.categoryName,
        product?.category,
        product?.categoryNameEn,
        product?.firstCategoryName,
        product?.category1Name,
        product?.oneCategoryName,
        product?.oneCategoryNameEn
      )
    );

  if (direct) {
    return direct;
  }

  /*
    CJ sometimes returns null category names
    in product/listV2.

    Therefore we safely infer a category
    from the product name instead of rejecting
    the product.
  */

  const text =
    getCJProductName(product)
      .toLowerCase();

  if (
    /\b(shirt|t-shirt|tee|polo|blouse|top|tank|sweater|hoodie|jacket|coat|vest|dress|skirt|jeans|trouser|pants|shorts|legging|jumpsuit|romper|suit)\b/
      .test(text)
  ) {
    return "Clothing";
  }

  if (
    /\b(shoe|shoes|sneaker|sneakers|boots|sandal|sandals|slipper|heels|loafer)\b/
      .test(text)
  ) {
    return "Shoes";
  }

  if (
    /\b(bag|bags|handbag|backpack|purse|wallet|clutch|tote)\b/
      .test(text)
  ) {
    return "Bags";
  }

  if (
    /\b(watch|watches|jewelry|jewellery|necklace|bracelet|ring|earring)\b/
      .test(text)
  ) {
    return "Accessories";
  }

  if (
    /\b(phone|case|charger|cable|electronic|earphone|headphone|speaker)\b/
      .test(text)
  ) {
    return "Electronics";
  }

  if (
    /\b(home|kitchen|lamp|storage|decor|decoration|furniture)\b/
      .test(text)
  ) {
    return "Home";
  }

  return "Other";
}

function getCJSubcategory(
  product
) {
  const direct =
    safeString(
      firstNonEmpty(
        product?.subCategoryName,
        product?.subcategory,
        product?.subCategoryNameEn,
        product?.secondCategoryName,
        product?.category2Name,
        product?.twoCategoryName,
        product?.twoCategoryNameEn
      )
    );

  if (direct) {
    return direct;
  }

  return "";
}

function getCJGender(product) {
  const text = (
    getCJProductName(product) +
    " " +
    getCJProductDescription(product) +
    " " +
    getCJCategory(product)
  ).toLowerCase();

  /*
    Check women-specific words first.
  */
  if (
    /\b(women|womens|woman|female|girl|girls|ladies|lady)\b/
      .test(text)
  ) {
    return "Women";
  }

  if (
    /\b(men|mens|male|boy|boys|man|gentlemen)\b/
      .test(text)
  ) {
    return "Men";
  }

  return "Unisex";
}

/* =========================================================
   NORMALIZATION
========================================================= */

function isNormalizedCatalogProduct(
  product
) {
  return (
    product &&
    typeof product === "object" &&
    safeString(product.id) &&
    safeString(
      product.name ||
      product.title
    )
  );
}

function normalizeCJProduct(
  product
) {
  if (
    !product ||
    typeof product !== "object"
  ) {
    return null;
  }

  const supplierProductId =
    getCJProductId(
      product
    );

  /*
    A CJ product must have an ID.
  */
  if (!supplierProductId) {
    return null;
  }

  const name =
    getCJProductName(
      product
    );

  /*
    IMPORTANT FIX:

    nameEn is now recognized, so CJ products
    are no longer rejected here.
  */
  if (!name) {
    return null;
  }

  const description =
    getCJProductDescription(
      product
    );

  const sku =
    getCJProductSku(
      product
    );

  const images =
    getCJProductImages(
      product
    );

  const image =
    getCJProductImage(
      product
    );

  const stock =
    getCJProductStock(
      product
    );

  const costInfo =
    getCJProductCostInfo(
      product
    );

  const costPrice =
    costInfo.min;

  const costPriceMax =
    costInfo.max;

  /*
    If CJ provides no usable price,
    don't store a fake product with a 0 price.
  */
  if (
    costPrice <= 0
  ) {
    return null;
  }

  const markupMultiplier =
    1 +
    GLOBIRA_MARKUP_PERCENT /
      100;

  const sellingPrice =
    Number(
      (
        costPrice *
        markupMultiplier
      ).toFixed(2)
    );

  const sellingPriceMax =
    Number(
      (
        costPriceMax *
        markupMultiplier
      ).toFixed(2)
    );

  const now =
    new Date().toISOString();

  const category =
    getCJCategory(
      product
    );

  const subcategory =
    getCJSubcategory(
      product
    );

  const gender =
    getCJGender(
      product
    );

  return {
    id:
      `cj_${supplierProductId}`,

    productId:
      supplierProductId,

    supplier:
      "CJ Dropshipping",

    source:
      "CJ Dropshipping",

    supplierProductId,

    supplierSku:
      sku,

    sku,

    name,

    title:
      name,

    description,

    image,

    images,

    category,

    subcategory,

    gender,

    costPrice,

    costPriceMin:
      costPrice,

    costPriceMax,

    supplierPrice:
      costPrice,

    cjPriceRange:
      costInfo.raw ||
      `${costPrice}-${costPriceMax}`,

    markupPercent:
      GLOBIRA_MARKUP_PERCENT,

    sellingPrice,

    customerPrice:
      sellingPrice,

    sellingPriceMin:
      sellingPrice,

    sellingPriceMax,

    currency:
      DEFAULT_CURRENCY,

    stock,

    available:
      stock >
      MIN_PRODUCT_STOCK,

    inStock:
      stock >
      MIN_PRODUCT_STOCK,

    cjAuthorityId:
      safeString(
        firstNonEmpty(
          product?.authorityId,
          product?.authorityID
        )
      ),

    cjSaleStatus:
      safeString(
        firstNonEmpty(
          product?.saleStatus,
          product?.status
        )
      ),

    cjCategoryId:
      safeString(
        firstNonEmpty(
          product?.categoryId,
          product?.categoryID
        )
      ),

    /*
      Keep useful CJ raw fields available
      for future supplier/order workflows.
    */
    cjListedNum:
      safeNumber(
        product?.listedNum,
        0
      ),

    cjWarehouseInventoryNum:
      safeNumber(
        product?.warehouseInventoryNum,
        stock
      ),

    cjProductType:
      safeString(
        product?.productType
      ),

    createdAt:
      now,

    updatedAt:
      now
  };
}

/* =========================================================
   CJ PRODUCT ARRAY EXTRACTION
========================================================= */

function looksLikeCJProduct(
  value
) {
  if (
    !value ||
    typeof value !== "object"
  ) {
    return false;
  }

  return Boolean(
    getCJProductId(value) &&
    (
      getCJProductName(value) ||
      getCJProductDescription(
        value
      )
    )
  );
}

function recursiveFindProductArray(
  value,
  depth = 0
) {
  if (
    depth > 10 ||
    value === null ||
    value === undefined
  ) {
    return null;
  }

  if (Array.isArray(value)) {
    if (
      value.length &&
      value.some(
        looksLikeCJProduct
      )
    ) {
      return value;
    }

    for (
      const item of value
    ) {
      const result =
        recursiveFindProductArray(
          item,
          depth + 1
        );

      if (result) {
        return result;
      }
    }

    return null;
  }

  if (
    typeof value === "object"
  ) {
    for (
      const key of Object.keys(
        value
      )
    ) {
      const result =
        recursiveFindProductArray(
          value[key],
          depth + 1
        );

      if (result) {
        return result;
      }
    }
  }

  return null;
}

function extractCJProducts(
  response
) {
  /*
    CJ Product List V2 commonly returns:

    data
      -> content[]
        -> productList[]
  */

  const directCandidates = [
    response?.data?.content?.[0]
      ?.productList,

    response?.data?.content
      ?.productList,

    response?.data?.data?.content?.[0]
      ?.productList,

    response?.data?.data?.content
      ?.productList,

    response?.content?.[0]
      ?.productList,

    response?.content
      ?.productList,

    response?.data
      ?.productList,

    response?.productList,

    response?.data
      ?.products,

    response?.products
  ];

  for (
    const candidate of
    directCandidates
  ) {
    if (
      Array.isArray(candidate) &&
      candidate.length
    ) {
      return candidate;
    }
  }

  const recursive =
    recursiveFindProductArray(
      response
    );

  return Array.isArray(recursive)
    ? recursive
    : [];
}

/* =========================================================
   CJ DEBUG
========================================================= */

let cjRawResponseLogged =
  false;

function logCJRawResponse(
  response,
  page
) {
  if (
    cjRawResponseLogged
  ) {
    return;
  }

  cjRawResponseLogged =
    true;

  console.log(
    `\n========== CJ RAW RESPONSE PAGE ${page} ==========\n`
  );

  try {
    console.log(
      JSON.stringify(
        response,
        null,
        2
      ).slice(
        0,
        10000
      )
    );
  } catch {
    console.log(response);
  }

  console.log(
    "\n========== END CJ RAW RESPONSE ==========\n"
  );
}

/* =========================================================
   FETCH CJ PRODUCTS
========================================================= */

async function fetchCJProducts(
  page,
  size
) {
  const params =
    new URLSearchParams();

  params.set(
    "page",
    String(page)
  );

  params.set(
    "size",
    String(size)
  );

  /*
    IMPORTANT:

    There is intentionally NO keyWord parameter.

    GLOBIRA requests the full CJ catalog
    instead of only "hoodie".
  */

  const endpoint =
    `/product/listV2?${params.toString()}`;

  console.log(
    `Fetching CJ products: page=${page}, size=${size}`
  );

  const response =
    await cjRequest(
      endpoint
    );

  logCJRawResponse(
    response,
    page
  );

  const products =
    extractCJProducts(
      response
    );

  /*
    CJ V2 pagination information.
  */

  const totalPages =
    safeNumber(
      firstNonEmpty(
        response?.data?.totalPages,
        response?.data?.data?.totalPages,
        response?.totalPages
      ),
      0
    );

  const totalRecords =
    safeNumber(
      firstNonEmpty(
        response?.data?.totalRecords,
        response?.data?.data?.totalRecords,
        response?.totalRecords
      ),
      0
    );

  console.log(
    `CJ page ${page}: extracted ${products.length} products`
  );

  console.log(
    `CJ pagination: totalPages=${totalPages}, totalRecords=${totalRecords}`
  );

  return {
    products,
    totalPages,
    totalRecords,
    raw: response
  };
}

/* =========================================================
   CJ CATALOG SYNC
========================================================= */

let syncRunning = false;

async function syncCJProducts() {
  if (syncRunning) {
    console.log(
      "CJ catalog sync already running. Skipping duplicate run."
    );

    return {
      success: false,
      skipped: true
    };
  }

  syncRunning = true;

  const startedAt =
    new Date().toISOString();

  console.log(
    "\n================================================="
  );

  console.log(
    "GLOBIRA CJ CATALOG SYNC STARTING"
  );

  console.log(
    `CJ API base: ${CJ_API_BASE}`
  );

  console.log(
    `CJ page size: ${CJ_PAGE_SIZE}`
  );

  console.log(
    `Maximum sync pages: ${CJ_SYNC_PAGES}`
  );

  console.log(
    `Normal page delay: ${CJ_PAGE_DELAY_MS}ms`
  );

  console.log(
    `429 maximum retries: ${CJ_MAX_429_RETRIES}`
  );

  console.log(
    `429 base retry delay: ${CJ_429_BASE_DELAY_MS}ms`
  );

  console.log(
    `Markup: ${GLOBIRA_MARKUP_PERCENT}%`
  );

  console.log(
    `Currency: ${DEFAULT_CURRENCY}`
  );

  console.log(
    "Keyword filter: DISABLED — ALL CATEGORIES"
  );

  console.log(
    "=================================================\n"
  );

  let totalFetched = 0;

  let totalNormalized = 0;

  const normalizedProducts = [];

  let totalRecordsReported = 0;

  let reportedTotalPages = 0;

  try {
    if (
      !CJ_API_KEY &&
      !CJ_ACCESS_TOKEN
    ) {
      throw new Error(
        "CJ_API_KEY and CJ_ACCESS_TOKEN are both missing."
      );
    }

    /*
      Get/verify CJ authentication
      before starting.
    */

    await getCJAccessToken();

    let pagesToFetch =
      CJ_SYNC_PAGES;

    for (
      let page = 1;
      page <= pagesToFetch;
      page++
    ) {
      if (page > 1) {
        console.log(
          `Waiting ${CJ_PAGE_DELAY_MS}ms before next CJ request...`
        );

        await sleep(
          CJ_PAGE_DELAY_MS
        );
      }

      let result;

      try {
        result =
          await fetchCJProducts(
            page,
            CJ_PAGE_SIZE
          );
      } catch (error) {
        console.error(
          `CJ page ${page} failed:`,
          error.message
        );

        if (error.status) {
          console.error(
            `CJ page ${page} HTTP status: ${error.status}`
          );
        }

        if (error.data) {
          console.error(
            "CJ error response:",
            JSON.stringify(
              error.data,
              null,
              2
            ).slice(
              0,
              5000
            )
          );
        }

        /*
          If page 1 fails,
          the entire sync fails.
        */

        if (page === 1) {
          throw error;
        }

        /*
          If a later page ultimately fails,
          stop rather than replacing a
          good catalog with incomplete data.
        */

        console.error(
          `Stopping CJ sync at page ${page} to protect existing catalog.`
        );

        throw error;
      }

      const products =
        Array.isArray(
          result.products
        )
          ? result.products
          : [];

      totalFetched +=
        products.length;

      if (result.totalRecords) {
        totalRecordsReported =
          result.totalRecords;
      }

      if (result.totalPages) {
        reportedTotalPages =
          result.totalPages;
      }

      /*
        After page 1 we know how many
        pages CJ says exist.
      */

      if (
        page === 1 &&
        result.totalPages > 0
      ) {
        pagesToFetch =
          Math.min(
            CJ_SYNC_PAGES,
            result.totalPages
          );

        console.log(
          `CJ reports ${result.totalPages} total pages / ${result.totalRecords} total records.`
        );

        console.log(
          `GLOBIRA will sync ${pagesToFetch} page(s).`
        );
      }

      if (!products.length) {
        console.log(
          `CJ page ${page} returned 0 products.`
        );

        if (page > 1) {
          console.log(
            "Empty CJ page detected. Ending pagination."
          );

          break;
        }

        if (page === 1) {
          throw new Error(
            "CJ returned 0 products on the first page."
          );
        }
      }

      for (
        const product of products
      ) {
        const normalized =
          normalizeCJProduct(
            product
          );

        if (!normalized) {
          continue;
        }

        normalizedProducts.push(
          normalized
        );

        totalNormalized++;
      }

      console.log(
        `CJ sync progress: page ${page}/${pagesToFetch}, fetched=${totalFetched}, normalized=${totalNormalized}`
      );

      /*
        If CJ says this was the final page,
        stop.
      */

      if (
        result.totalPages > 0 &&
        page >= result.totalPages
      ) {
        console.log(
          "Reached CJ reported final page."
        );

        break;
      }
    }

    /*
      Deduplicate products.
    */

    const uniqueProducts =
      new Map();

    for (
      const product of normalizedProducts
    ) {
      const key =
        safeString(
          product.supplierProductId ||
          product.productId ||
          product.id
        );

      if (!key) {
        continue;
      }

      uniqueProducts.set(
        key,
        product
      );
    }

    const products =
      Array.from(
        uniqueProducts.values()
      );

    /*
      DO NOT replace an existing good catalog
      with an empty catalog.
    */

    if (!products.length) {
      const existing =
        loadCatalog();

      const meta = {
        ...(existing.meta || {}),

        lastSyncAt:
          new Date().toISOString(),

        lastSyncSuccess:
          false,

        lastSyncMessage:
          "CJ catalog sync completed, but 0 products could be normalized. Check CJ product field mapping.",

        totalFetched,

        totalNormalized,

        totalStored:
          existing.products.length,

        availableProducts:
          existing.products.filter(
            (product) =>
              product.available
          ).length,

        reportedTotalRecords:
          totalRecordsReported,

        reportedTotalPages:
          reportedTotalPages
      };

      saveCatalog(
        existing.products,
        meta
      );

      console.error(
        "CJ sync produced 0 products. Existing catalog was preserved."
      );

      return {
        success: false,

        message:
          meta.lastSyncMessage,

        totalFetched,

        totalNormalized,

        totalStored:
          existing.products.length
      };
    }

    const availableProducts =
      products.filter(
        (product) =>
          product.stock >
          MIN_PRODUCT_STOCK
      );

    const meta = {
      lastSyncAt:
        new Date().toISOString(),

      lastSyncSuccess:
        true,

      lastSyncMessage:
        "CJ catalog sync completed successfully.",

      totalFetched,

      totalNormalized,

      totalStored:
        products.length,

      availableProducts:
        availableProducts.length,

      reportedTotalRecords:
        totalRecordsReported,

      reportedTotalPages:
        reportedTotalPages,

      syncedAt:
        startedAt,

      syncFinishedAt:
        new Date().toISOString(),

      pageSize:
        CJ_PAGE_SIZE,

      maxSyncPages:
        CJ_SYNC_PAGES,

      markupPercent:
        GLOBIRA_MARKUP_PERCENT,

      currency:
        DEFAULT_CURRENCY
    };

    saveCatalog(
      products,
      meta
    );

    console.log(
      "\n================================================="
    );

    console.log(
      "GLOBIRA CJ CATALOG SYNC COMPLETED"
    );

    console.log(
      `Fetched: ${totalFetched}`
    );

    console.log(
      `Normalized: ${totalNormalized}`
    );

    console.log(
      `Stored: ${products.length}`
    );

    console.log(
      `Available: ${availableProducts.length}`
    );

    console.log(
      `CJ reported records: ${totalRecordsReported}`
    );

    console.log(
      `CJ reported pages: ${reportedTotalPages}`
    );

    console.log(
      "=================================================\n"
    );

    return {
      success: true,

      totalFetched,

      totalNormalized,

      totalStored:
        products.length,

      availableProducts:
        availableProducts.length,

      reportedTotalRecords:
        totalRecordsReported,

      reportedTotalPages:
        reportedTotalPages
    };
  } catch (error) {
    console.error(
      "\nCJ CATALOG SYNC FAILED:"
    );

    console.error(
      error.message
    );

    if (error.status) {
      console.error(
        "HTTP status:",
        error.status
      );
    }

    if (error.data) {
      console.error(
        "CJ response:",
        JSON.stringify(
          error.data,
          null,
          2
        ).slice(
          0,
          10000
        )
      );
    }

    /*
      Preserve existing catalog if sync fails.
    */

    const existing =
      loadCatalog();

    const meta = {
      ...(existing.meta || {}),

      lastSyncAt:
        new Date().toISOString(),

      lastSyncSuccess:
        false,

      lastSyncMessage:
        error.message,

      totalFetched,

      totalNormalized,

      totalStored:
        existing.products.length,

      availableProducts:
        existing.products.filter(
          (product) =>
            product.available
        ).length,

      reportedTotalRecords:
        totalRecordsReported,

      reportedTotalPages:
        reportedTotalPages
    };

    saveCatalog(
      existing.products,
      meta
    );

    return {
      success: false,

      message:
        error.message,

      totalFetched,

      totalNormalized,

      totalStored:
        existing.products.length
    };
  } finally {
    syncRunning = false;
  }
}

/* =========================================================
   PUBLIC PRODUCT API
========================================================= */

app.get(
  "/api/products",
  (req, res) => {
    try {
      const catalog =
        loadCatalog();

      let products =
        Array.isArray(
          catalog.products
        )
          ? catalog.products
          : [];

      const search =
        safeString(
          req.query.search
        ).toLowerCase();

      const category =
        safeString(
          req.query.category
        ).toLowerCase();

      const gender =
        safeString(
          req.query.gender
        ).toLowerCase();

      if (search) {
        products =
          products.filter(
            (product) => {
              const text = [
                product.name,
                product.title,
                product.description,
                product.category,
                product.subcategory,
                product.gender,
                product.sku
              ]
                .map(
                  safeString
                )
                .join(" ")
                .toLowerCase();

              return text.includes(
                search
              );
            }
          );
      }

      if (category) {
        products =
          products.filter(
            (product) =>
              safeString(
                product.category
              )
                .toLowerCase()
                .includes(
                  category
                ) ||
              safeString(
                product.subcategory
              )
                .toLowerCase()
                .includes(
                  category
                )
          );
      }

      if (gender) {
        products =
          products.filter(
            (product) =>
              safeString(
                product.gender
              )
                .toLowerCase() ===
              gender
          );
      }

      return res.json({
        success: true,

        count:
          products.length,

        currency:
          DEFAULT_CURRENCY,

        markupPercent:
          GLOBIRA_MARKUP_PERCENT,

        products,

        meta:
          catalog.meta || {}
      });
    } catch (error) {
      console.error(
        "/api/products error:",
        error.message
      );

      return res.status(500).json({
        success: false,
        message:
          "Failed to load products."
      });
    }
  }
);

/* =========================================================
   CATALOG STATUS
========================================================= */

app.get(
  "/api/catalog-status",
  (req, res) => {
    const catalog =
      loadCatalog();

    return res.json({
      success: true,

      count:
        catalog.products.length,

      currency:
        DEFAULT_CURRENCY,

      markupPercent:
        GLOBIRA_MARKUP_PERCENT,

      meta:
        catalog.meta || {}
    });
  }
);

/* =========================================================
   MANUAL CJ SYNC
========================================================= */

app.post(
  "/api/sync-products",
  async (req, res) => {
    try {
      const result =
        await syncCJProducts();

      return res.json(
        result
      );
    } catch (error) {
      return res.status(500).json({
        success: false,
        message:
          error.message
      });
    }
  }
);

/* =========================================================
   TEST CJ
========================================================= */

app.get(
  "/test-printify",
  async (req, res) => {
    /*
      Kept for compatibility with the existing
      GLOBIRA project.

      Printify is not used for the CJ catalog.
    */

    return res.json({
      success: true,

      message:
        "GLOBIRA backend is running. CJ Dropshipping is the active catalog supplier."
    });
  }
);

app.get(
  "/api/test",
  (req, res) => {
    return res.json({
      success: true,

      message:
        "GLOBIRA backend working",

      currency:
        DEFAULT_CURRENCY
    });
  }
);

/* =========================================================
   ADMIN LOGIN
========================================================= */

app.post(
  "/api/admin/login",
  (req, res) => {
    const password =
      safeString(
        req.body?.password
      );

    if (!ADMIN_PASSWORD) {
      return res.status(500).json({
        success: false,
        message:
          "ADMIN_PASSWORD is not configured."
      });
    }

    if (
      password !==
      ADMIN_PASSWORD
    ) {
      return res.status(401).json({
        success: false,
        message:
          "Invalid admin password."
      });
    }

    const token =
      createAdminSession();

    setAdminCookie(
      res,
      token
    );

    return res.json({
      success: true,

      message:
        "Admin login successful."
    });
  }
);

/* =========================================================
   ADMIN LOGOUT
========================================================= */

app.post(
  "/api/admin/logout",
  requireAdmin,
  (req, res) => {
    const token =
      getCookie(
        req,
        "globira_admin_session"
      );

    if (token) {
      adminSessions.delete(
        token
      );
    }

    clearAdminCookie(
      res
    );

    return res.json({
      success: true
    });
  }
);

/* =========================================================
   ADMIN SESSION CHECK
========================================================= */

app.get(
  "/api/admin/session",
  requireAdmin,
  (req, res) => {
    return res.json({
      success: true,
      authenticated: true
    });
  }
);

/* =========================================================
   ADMIN ORDERS
========================================================= */

app.get(
  "/api/admin/orders",
  requireAdmin,
  (req, res) => {
    const orders =
      loadOrders();

    return res.json({
      success: true,

      count:
        orders.length,

      orders
    });
  }
);

/* =========================================================
   CREATE CUSTOMER ORDER
========================================================= */

app.post(
  "/api/orders",
  (req, res) => {
    try {
      const body =
        req.body || {};

      const orders =
        loadOrders();

      const now =
        new Date().toISOString();

      const order = {
        id:
          makeId(
            "GLOBIRA-"
          ),

        orderNumber:
          `GLB-${Date.now()}`,

        createdAt:
          now,

        updatedAt:
          now,

        customer:
          body.customer || {},

        items:
          Array.isArray(
            body.items
          )
            ? body.items
            : [],

        total:
          safeNumber(
            body.total,
            0
          ),

        currency:
          safeString(
            body.currency
          ) ||
          DEFAULT_CURRENCY,

        paymentStatus:
          "PENDING",

        status:
          "PROCESSING",

        cjOrderId:
          "",

        cjStatus:
          "",

        cjPaymentStatus:
          "UNPAID"
      };

      orders.push(
        order
      );

      saveOrders(
        orders
      );

      return res.status(201).json({
        success: true,
        order
      });
    } catch (error) {
      console.error(
        "Create order error:",
        error.message
      );

      return res.status(500).json({
        success: false,
        message:
          "Failed to create order."
      });
    }
  }
);

/* =========================================================
   ADMIN CONFIRM CUSTOMER PAYMENT
========================================================= */

app.post(
  "/api/admin/orders/:id/confirm-payment",
  requireAdmin,
  (req, res) => {
    const orders =
      loadOrders();

    const order =
      orders.find(
        (item) =>
          item.id ===
          req.params.id
      );

    if (!order) {
      return res.status(404).json({
        success: false,
        message:
          "Order not found."
      });
    }

    order.paymentStatus =
      "CONFIRMED";

    order.updatedAt =
      new Date().toISOString();

    saveOrders(
      orders
    );

    return res.json({
      success: true,
      order
    });
  }
);

/* =========================================================
   ADMIN CANCEL ORDER
========================================================= */

app.post(
  "/api/admin/orders/:id/cancel",
  requireAdmin,
  (req, res) => {
    const orders =
      loadOrders();

    const order =
      orders.find(
        (item) =>
          item.id ===
          req.params.id
      );

    if (!order) {
      return res.status(404).json({
        success: false,
        message:
          "Order not found."
      });
    }

    order.status =
      "CANCELLED";

    order.updatedAt =
      new Date().toISOString();

    saveOrders(
      orders
    );

    return res.json({
      success: true,
      order
    });
  }
);

/* =========================================================
   ADMIN SEND ORDER TO CJ
========================================================= */

app.post(
  "/api/admin/orders/:id/send-to-cj",
  requireAdmin,
  (req, res) => {
    const orders =
      loadOrders();

    const order =
      orders.find(
        (item) =>
          item.id ===
          req.params.id
      );

    if (!order) {
      return res.status(404).json({
        success: false,
        message:
          "Order not found."
      });
    }

    if (
      order.paymentStatus !==
      "CONFIRMED"
    ) {
      return res.status(400).json({
        success: false,

        message:
          "Customer payment must be confirmed before sending the order to CJ."
      });
    }

    /*
      CJ order creation/payment is intentionally
      NOT automated yet.

      This marks the order as ready for the
      manual CJ processing workflow.
    */

    order.cjStatus =
      "READY_FOR_CJ";

    order.cjPaymentStatus =
      "UNPAID";

    order.updatedAt =
      new Date().toISOString();

    saveOrders(
      orders
    );

    return res.json({
      success: true,

      message:
        "Order marked ready for CJ. CJ payment remains manual.",

      order
    });
  }
);

/* =========================================================
   ADMIN SYNC CJ ORDER STATUS
========================================================= */

app.post(
  "/api/admin/orders/:id/sync-cj",
  requireAdmin,
  (req, res) => {
    const orders =
      loadOrders();

    const order =
      orders.find(
        (item) =>
          item.id ===
          req.params.id
      );

    if (!order) {
      return res.status(404).json({
        success: false,
        message:
          "Order not found."
      });
    }

    /*
      Actual CJ order status API can be connected
      later when the order workflow is ready.
    */

    order.updatedAt =
      new Date().toISOString();

    saveOrders(
      orders
    );

    return res.json({
      success: true,

      message:
        "CJ status sync placeholder completed.",

      order
    });
  }
);

/* =========================================================
   STATIC FILES
========================================================= */

app.use(
  express.static(
    __dirname
  )
);

/* =========================================================
   HTML ROUTES
========================================================= */

app.get(
  "/",
  (req, res) => {
    res.sendFile(
      path.join(
        __dirname,
        "index.html"
      )
    );
  }
);

app.get(
  "/supplier",
  (req, res) => {
    const file =
      path.join(
        __dirname,
        "supplier.html"
      );

    if (
      fs.existsSync(file)
    ) {
      return res.sendFile(
        file
      );
    }

    return res.status(404).send(
      "Supplier page not found."
    );
  }
);

app.get(
  "/supplier-dashboard",
  (req, res) => {
    const file =
      path.join(
        __dirname,
        "supplier-dashboard.html"
      );

    if (
      fs.existsSync(file)
    ) {
      return res.sendFile(
        file
      );
    }

    return res.status(404).send(
      "Supplier dashboard not found."
    );
  }
);

/* =========================================================
   ADMIN PAGE
========================================================= */

app.get(
  "/admin",
  (req, res) => {
    const possibleFiles = [
      "admin.html",
      "admin-dashboard.html"
    ];

    for (
      const filename of possibleFiles
    ) {
      const file =
        path.join(
          __dirname,
          filename
        );

      if (
        fs.existsSync(file)
      ) {
        return res.sendFile(
          file
        );
      }
    }

    return res.status(404).send(
      "Admin page not found."
    );
  }
);

/* =========================================================
   404
========================================================= */

app.use(
  (req, res) => {
    if (
      req.path.startsWith(
        "/api/"
      )
    ) {
      return res.status(404).json({
        success: false,
        message:
          "API endpoint not found."
      });
    }

    return res.status(404).send(
      "Page not found."
    );
  }
);

/* =========================================================
   ERROR HANDLER
========================================================= */

app.use(
  (
    error,
    req,
    res,
    next
  ) => {
    console.error(
      "Unhandled server error:",
      error
    );

    if (
      res.headersSent
    ) {
      return next(error);
    }

    return res.status(500).json({
      success: false,
      message:
        "Internal server error."
    });
  }
);

/* =========================================================
   START SERVER
========================================================= */

app.listen(
  PORT,
  () => {
    console.log(
      "\n=============================================="
    );

    console.log(
      "GLOBIRA SERVER STARTED"
    );

    console.log(
      `Port: ${PORT}`
    );

    console.log(
      `Currency: ${DEFAULT_CURRENCY}`
    );

    console.log(
      `Markup: ${GLOBIRA_MARKUP_PERCENT}%`
    );

    console.log(
      `CJ page size: ${CJ_PAGE_SIZE}`
    );

    console.log(
      `CJ max sync pages: ${CJ_SYNC_PAGES}`
    );

    console.log(
      `CJ normal page delay: ${CJ_PAGE_DELAY_MS}ms`
    );

    console.log(
      `CJ 429 max retries: ${CJ_MAX_429_RETRIES}`
    );

    console.log(
      `CJ 429 base delay: ${CJ_429_BASE_DELAY_MS}ms`
    );

    console.log(
      `CJ catalog sync interval: ${PRODUCT_SYNC_INTERVAL_MINUTES} minutes`
    );

    console.log(
      "CJ catalog: ALL CATEGORIES"
    );

    console.log(
      "==============================================\n"
    );

    /*
      Initial sync shortly after server starts.
    */

    setTimeout(
      () => {
        syncCJProducts()
          .catch(
            (error) => {
              console.error(
                "Initial CJ sync error:",
                error.message
              );
            }
          );
      },
      1500
    );

    /*
      Automatic periodic sync.
    */

    setInterval(
      () => {
        syncCJProducts()
          .catch(
            (error) => {
              console.error(
                "Scheduled CJ sync error:",
                error.message
              );
            }
          );
      },
      PRODUCT_SYNC_INTERVAL_MINUTES *
        60 *
        1000
    );
  }
);
