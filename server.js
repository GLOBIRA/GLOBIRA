require("dotenv").config();

const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));

/* =========================================================
   CORS
========================================================= */

const ADMIN_ORIGIN = "https://globira-admin.vercel.app";

app.use((req, res, next) => {
    const origin = req.headers.origin;

    res.setHeader("Vary", "Origin");

    if (
        origin === ADMIN_ORIGIN ||
        origin === "https://globira.vercel.app" ||
        origin === "http://localhost:3000"
    ) {
        res.setHeader(
            "Access-Control-Allow-Origin",
            origin
        );

        res.setHeader(
            "Access-Control-Allow-Credentials",
            "true"
        );

        res.setHeader(
            "Access-Control-Allow-Headers",
            "Content-Type, Authorization"
        );

        res.setHeader(
            "Access-Control-Allow-Methods",
            "GET,POST,PUT,PATCH,DELETE,OPTIONS"
        );
    }

    if (req.method === "OPTIONS") {
        return res.sendStatus(204);
    }

    next();
});

const ROOT = __dirname;

/* =========================================================
   FILES
========================================================= */

const ORDERS_FILE = path.join(
    ROOT,
    ".globira-orders.json"
);

const CATALOG_FILE = path.join(
    ROOT,
    ".globira-catalog.json"
);

/* =========================================================
   ADMIN
========================================================= */

const ADMIN_PASSWORD = String(
    process.env.ADMIN_PASSWORD || "admin123"
).trim();

const ADMIN_COOKIE = "globira_admin";

const SESSION_TIME =
    8 * 60 * 60 * 1000;

const sessions = new Map();

/* =========================================================
   CJ SETTINGS
========================================================= */

/*
 * CJ access token.
 *
 * IMPORTANT:
 * Keep this in Vercel Environment Variables.
 *
 * CJ_ACCESS_TOKEN=xxxxxxxx
 */

const CJ_ACCESS_TOKEN = String(
    process.env.CJ_ACCESS_TOKEN || ""
).trim();

/*
 * Optional fallback name.
 *
 * If you already have CJ_ACCESS_TOKEN,
 * that remains the preferred value.
 */

const CJ_API_KEY = String(
    process.env.CJ_API_KEY || ""
).trim();

const CJ_API_BASE =
    "https://developers.cjdropshipping.com/api2.0/v1";

const CJ_PRODUCT_LIST_URL =
    `${CJ_API_BASE}/product/listV2`;

/*
 * CJ allows up to 100 products per request.
 */

const CJ_PAGE_SIZE = 100;

/*
 * GLOBIRA markup.
 *
 * Example:
 *
 * CJ cost = $10
 * 60% markup = $16
 */

const GLOBIRA_MARKUP_PERCENT = Math.max(
    0,
    Number(
        process.env.GLOBIRA_MARKUP_PERCENT || 60
    )
);

const DEFAULT_CURRENCY =
    process.env.DEFAULT_CURRENCY || "INR";

const MIN_PRODUCT_STOCK = Math.max(
    0,
    Number(
        process.env.MIN_PRODUCT_STOCK || 0
    )
);

/* =========================================================
   GENERIC HELPERS
========================================================= */

function roundMoney(value) {
    const number = Number(value);

    if (!Number.isFinite(number)) {
        return 0;
    }

    return Math.round(number * 100) / 100;
}

function normalizeText(value) {
    return String(value || "")
        .trim()
        .toLowerCase();
}

function safeArray(value) {
    return Array.isArray(value)
        ? value
        : [];
}

/* =========================================================
   ORDER STORAGE
========================================================= */

function ensureOrdersFile() {
    if (!fs.existsSync(ORDERS_FILE)) {
        fs.writeFileSync(
            ORDERS_FILE,
            JSON.stringify([], null, 2),
            "utf8"
        );
    }
}

function readOrders() {
    ensureOrdersFile();

    try {
        const data = fs.readFileSync(
            ORDERS_FILE,
            "utf8"
        );

        const orders = JSON.parse(data);

        return Array.isArray(orders)
            ? orders
            : [];
    } catch (error) {
        console.error(
            "Could not read orders:",
            error
        );

        return [];
    }
}

function saveOrders(orders) {
    fs.writeFileSync(
        ORDERS_FILE,
        JSON.stringify(
            orders,
            null,
            2
        ),
        "utf8"
    );
}

function generateOrderNumber() {
    const now = new Date();

    const date =
        now.getFullYear().toString() +
        String(
            now.getMonth() + 1
        ).padStart(2, "0") +
        String(
            now.getDate()
        ).padStart(2, "0");

    const random =
        crypto
            .randomBytes(3)
            .toString("hex")
            .toUpperCase();

    return `GLOBIRA-${date}-${random}`;
}

/* =========================================================
   LOCAL CATALOG
   Used for local/manual sync and compatibility.
   CUSTOMER API DOES NOT DEPEND ON THIS.
========================================================= */

function emptyCatalog() {
    return {
        version: 1,
        updatedAt: null,
        lastSync: null,
        syncSource: "CJ Dropshipping",
        products: []
    };
}

function ensureCatalogFile() {
    if (!fs.existsSync(CATALOG_FILE)) {
        fs.writeFileSync(
            CATALOG_FILE,
            JSON.stringify(
                emptyCatalog(),
                null,
                2
            ),
            "utf8"
        );
    }
}

function readCatalog() {
    ensureCatalogFile();

    try {
        const data =
            fs.readFileSync(
                CATALOG_FILE,
                "utf8"
            );

        const catalog =
            JSON.parse(data);

        if (
            !catalog ||
            typeof catalog !== "object"
        ) {
            return emptyCatalog();
        }

        if (
            !Array.isArray(
                catalog.products
            )
        ) {
            catalog.products = [];
        }

        return catalog;
    } catch (error) {
        console.error(
            "Could not read catalog:",
            error
        );

        return emptyCatalog();
    }
}

function saveCatalog(catalog) {
    catalog.version = 1;

    catalog.updatedAt =
        new Date().toISOString();

    fs.writeFileSync(
        CATALOG_FILE,
        JSON.stringify(
            catalog,
            null,
            2
        ),
        "utf8"
    );
}

function getAvailableCatalogProducts() {
    const catalog =
        readCatalog();

    return catalog.products.filter(
        product =>
            product &&
            product.available === true
    );
}

/* =========================================================
   PRICE
========================================================= */

function calculateGlobiraPrice(
    supplierCost
) {
    const cost =
        Number(supplierCost || 0);

    if (
        !Number.isFinite(cost) ||
        cost <= 0
    ) {
        return 0;
    }

    return roundMoney(
        cost *
        (
            1 +
            GLOBIRA_MARKUP_PERCENT / 100
        )
    );
}

/* =========================================================
   CJ PRODUCT NORMALIZATION
========================================================= */

function normalizeCJProduct(product) {
    if (!product) {
        return null;
    }

    const supplierCost =
        Number(
            product.nowPrice ??
            product.discountPrice ??
            product.sellPrice ??
            product.minPrice ??
            0
        );

    const stock = Math.max(
        0,
        Number(
            product.warehouseInventoryNum ??
            product.totalVerifiedInventory ??
            product.inventory ??
            product.stock ??
            0
        )
    );

    const saleStatus =
        String(
            product.saleStatus ??
            "3"
        );

    /*
     * listV2 itself returns available CJ products.
     *
     * Do NOT require warehouseInventoryNum here,
     * because that field is not guaranteed on every
     * listV2 result.
     */

    const available =
        supplierCost > 0 &&
        (
            stock > 0 ||
            product.inventory === undefined &&
            product.warehouseInventoryNum === undefined &&
            product.totalVerifiedInventory === undefined
        );

    const name =
        product.nameEn ||
        product.productNameEn ||
        product.name ||
        product.productName ||
        "GLOBIRA Product";

    const mainImage =
        product.bigImage ||
        product.productImage ||
        product.image ||
        "";

    /*
     * CJ can return different image fields depending
     * on endpoint/version.
     */

    let images = [];

    if (
        Array.isArray(
            product.productImageSet
        )
    ) {
        images.push(
            ...product.productImageSet
        );
    }

    if (
        Array.isArray(
            product.images
        )
    ) {
        images.push(
            ...product.images
        );
    }

    if (
        Array.isArray(
            product.imageList
        )
    ) {
        images.push(
            ...product.imageList
        );
    }

    if (mainImage) {
        images.unshift(mainImage);
    }

    images = [
        ...new Set(
            images
                .map(item => {
                    if (
                        typeof item ===
                        "string"
                    ) {
                        return item;
                    }

                    return (
                        item?.url ||
                        item?.imageUrl ||
                        item?.bigImage ||
                        ""
                    );
                })
                .filter(Boolean)
        )
    ];

    const category =
        product.threeCategoryName ||
        product.categoryName ||
        product.twoCategoryName ||
        product.oneCategoryName ||
        product.category ||
        "Other";

    const parentCategory =
        product.oneCategoryName ||
        "";

    const subCategory =
        product.twoCategoryName ||
        "";

    const globiraPrice =
        calculateGlobiraPrice(
            supplierCost
        );

    const supplierProductId =
        String(
            product.id ||
            product.pid ||
            product.productId ||
            ""
        );

    const supplierSku =
        String(
            product.sku ||
            product.spu ||
            product.productSku ||
            ""
        );

    return {
        id:
            `cj_${supplierProductId || supplierSku}`,

        cjProductId:
            supplierProductId,

        pid:
            supplierProductId,

        supplier:
            "cjdropshipping",

        source:
            "cjdropshipping",

        sourceType:
            "supplier",

        supplierName:
            "CJ Dropshipping",

        supplierProductId,

        supplierSku,

        sku:
            supplierSku,

        name,

        title:
            name,

        description:
            product.description ||
            "",

        image:
            images[0] ||
            mainImage ||
            "",

        images,

        category,

        categoryId:
            product.categoryId ||
            null,

        parentCategory,

        subCategory,

        gender:
            product.gender ||
            "",

        supplierCost:
            roundMoney(
                supplierCost
            ),

        supplierCurrency:
            "USD",

        price:
            globiraPrice,

        salePrice:
            globiraPrice,

        customerPrice:
            globiraPrice,

        oldPrice:
            globiraPrice > 0
                ? roundMoney(
                    globiraPrice *
                    1.2
                )
                : 0,

        currency:
            "USD",

        markupPercent:
            GLOBIRA_MARKUP_PERCENT,

        stock,

        available,

        saleStatus,

        variants:
            safeArray(
                product.variants ||
                product.variantList
            ),

        deliveryCycle:
            product.deliveryCycle ||
            null,

        verifiedWarehouse:
            product.verifiedWarehouse ??
            null,

        freeShipping:
            Number(
                product.addMarkStatus ||
                0
            ) === 1,

        customization:
            Number(
                product.customization ||
                product.isPersonalized ||
                0
            ) === 1,

        syncedAt:
            new Date().toISOString()
    };
}

/* =========================================================
   CJ TOKEN / REQUEST
========================================================= */

/*
 * Existing CJ_ACCESS_TOKEN remains the primary method.
 *
 * CJ requires an access token for product API calls.
 */

async function getCJAccessToken() {
    if (CJ_ACCESS_TOKEN) {
        return CJ_ACCESS_TOKEN;
    }

    /*
     * We intentionally do not expose CJ_API_KEY
     * to the frontend.
     *
     * If only CJ_API_KEY is configured, try the
     * CJ authentication endpoint.
     */

    if (!CJ_API_KEY) {
        throw new Error(
            "CJ_ACCESS_TOKEN is not configured."
        );
    }

    const response =
        await fetch(
            `${CJ_API_BASE}/authentication/getAccessToken`,
            {
                method: "POST",

                headers: {
                    "Content-Type":
                        "application/json",
                    "Accept":
                        "application/json"
                },

                body:
                    JSON.stringify({
                        apiKey:
                            CJ_API_KEY
                    })
            }
        );

    const text =
        await response.text();

    let data;

    try {
        data =
            JSON.parse(text);
    } catch {
        throw new Error(
            `CJ authentication returned invalid JSON. HTTP ${response.status}`
        );
    }

    if (
        !response.ok ||
        data.result === false ||
        data.success === false
    ) {
        throw new Error(
            `CJ authentication failed: ${
                data.message ||
                "Unknown authentication error"
            }`
        );
    }

    const token =
        data?.data?.accessToken ||
        data?.data?.access_token ||
        "";

    if (!token) {
        throw new Error(
            "CJ authentication succeeded but no access token was returned."
        );
    }

    return token;
}

async function cjGET(
    url
) {
    const token =
        await getCJAccessToken();

    const response =
        await fetch(
            url,
            {
                method: "GET",

                headers: {
                    "CJ-Access-Token":
                        token,

                    "Accept":
                        "application/json"
                }
            }
        );

    const text =
        await response.text();

    let data;

    try {
        data =
            JSON.parse(text);
    } catch {
        throw new Error(
            `CJ returned invalid JSON. HTTP ${response.status}`
        );
    }

    if (!response.ok) {
        throw new Error(
            `CJ API HTTP ${response.status}: ${
                data.message ||
                "Unknown error"
            }`
        );
    }

    if (
        data.result === false ||
        data.success === false
    ) {
        throw new Error(
            `CJ API error: ${
                data.message ||
                "Request failed"
            }`
        );
    }

    return data;
}

/* =========================================================
   LIVE CJ PRODUCT REQUEST
========================================================= */

/*
 * THIS IS THE IMPORTANT FIX.
 *
 * Vercel no longer depends on:
 *
 * .globira-catalog.json
 *
 * /api/products talks directly to CJ.
 */

async function fetchCJProductPage({
    page = 1,
    size = 100,
    keyword = "",
    categoryId = "",
    countryCode = ""
}) {
    const url =
        new URL(
            CJ_PRODUCT_LIST_URL
        );

    url.searchParams.set(
        "page",
        String(
            Math.max(
                1,
                Math.min(
                    1000,
                    Number(page) || 1
                )
            )
        )
    );

    url.searchParams.set(
        "size",
        String(
            Math.max(
                1,
                Math.min(
                    100,
                    Number(size) || 100
                )
            )
        )
    );

    /*
     * CJ uses keyWord with capital W.
     */

    if (keyword) {
        url.searchParams.set(
            "keyWord",
            String(keyword).trim()
        );
    }

    if (categoryId) {
        url.searchParams.set(
            "categoryId",
            String(categoryId).trim()
        );
    }

    if (countryCode) {
        url.searchParams.set(
            "countryCode",
            String(countryCode).trim()
        );
    }

    const data =
        await cjGET(
            url.toString()
        );

    const payload =
        data?.data || {};

    const content =
        Array.isArray(
            payload.content
        )
            ? payload.content
            : [];

    let rawProducts = [];

    /*
     * CJ wraps products inside
     * content[].productList.
     */

    for (
        const group of content
    ) {
        if (
            Array.isArray(
                group?.productList
            )
        ) {
            rawProducts.push(
                ...group.productList
            );
        }
    }

    const products =
        rawProducts
            .map(
                normalizeCJProduct
            )
            .filter(Boolean);

    /*
     * Deduplicate.
     */

    const unique =
        new Map();

    for (
        const product of products
    ) {
        const key =
            product.cjProductId ||
            product.sku ||
            product.id;

        if (key) {
            unique.set(
                key,
                product
            );
        }
    }

    return {
        products:
            Array.from(
                unique.values()
            ),

        total:
            Number(
                payload.totalRecords ||
                0
            ),

        totalPages:
            Number(
                payload.totalPages ||
                0
            ),

        page:
            Number(
                payload.pageNumber ||
                page
            ),

        size:
            Number(
                payload.pageSize ||
                size
            )
    };
}

/* =========================================================
   LOCAL CATALOG SYNC
========================================================= */

let productSyncRunning = false;

async function syncCJProducts() {
    if (productSyncRunning) {
        return {
            success: false,
            skipped: true,
            reason:
                "Product sync already running"
        };
    }

    productSyncRunning = true;

    try {
        const pages =
            Math.max(
                1,
                Math.min(
                    60,
                    Number(
                        process.env.CJ_SYNC_PAGES ||
                        60
                    )
                )
            );

        const collected = [];

        for (
            let page = 1;
            page <= pages;
            page++
        ) {
            try {
                const result =
                    await fetchCJProductPage({
                        page,
                        size:
                            CJ_PAGE_SIZE
                    });

                collected.push(
                    ...result.products
                );

                console.log(
                    `CJ sync page ${page}: ${result.products.length} products`
                );

                if (
                    !result.products.length ||
                    (
                        result.totalPages &&
                        page >=
                        result.totalPages
                    )
                ) {
                    break;
                }

                /*
                 * Respect CJ request limits.
                 */

                if (
                    page < pages
                ) {
                    await new Promise(
                        resolve =>
                            setTimeout(
                                resolve,
                                1100
                            )
                    );
                }
            } catch (error) {
                console.error(
                    `CJ sync page ${page} failed:`,
                    error.message
                );

                break;
            }
        }

        if (!collected.length) {
            return {
                success: false,
                productsFetched: 0,
                catalogPreserved: true
            };
        }

        const unique =
            new Map();

        for (
            const product of collected
        ) {
            const key =
                product.cjProductId ||
                product.sku ||
                product.id;

            if (key) {
                unique.set(
                    key,
                    product
                );
            }
        }

        const products =
            Array.from(
                unique.values()
            );

        const catalog = {
            version: 1,

            updatedAt:
                new Date().toISOString(),

            lastSync:
                new Date().toISOString(),

            syncSource:
                "CJ Dropshipping",

            products
        };

        saveCatalog(
            catalog
        );

        return {
            success: true,

            productsFetched:
                collected.length,

            productsStored:
                products.length,

            syncedAt:
                catalog.lastSync
        };
    } catch (error) {
        console.error(
            "PRODUCT SYNC ERROR:",
            error
        );

        return {
            success: false,
            error:
                error.message,
            catalogPreserved:
                true
        };
    } finally {
        productSyncRunning =
            false;
    }
}

/* =========================================================
   LOCAL SEARCH
========================================================= */

function searchCatalog(
    keyword,
    page = 1,
    size = 100
) {
    const products =
        getAvailableCatalogProducts();

    const cleanKeyword =
        normalizeText(
            keyword
        );

    let filtered =
        products;

    if (cleanKeyword) {
        const words =
            cleanKeyword
                .split(/\s+/)
                .filter(Boolean);

        filtered =
            products.filter(
                product => {
                    const searchable =
                        [
                            product.name,
                            product.title,
                            product.description,
                            product.category,
                            product.parentCategory,
                            product.subCategory,
                            product.sku,
                            product.supplierSku
                        ]
                            .join(" ")
                            .toLowerCase();

                    return words.every(
                        word =>
                            searchable.includes(
                                word
                            )
                    );
                }
            );
    }

    const total =
        filtered.length;

    const start =
        Math.max(
            0,
            (page - 1) * size
        );

    const end =
        start + size;

    return {
        products:
            filtered.slice(
                start,
                end
            ),

        total,

        page,

        size,

        totalPages:
            Math.ceil(
                total / size
            )
    };
}

/* =========================================================
   COOKIE / ADMIN SESSION
========================================================= */

function parseCookies(req) {
    const header =
        req.headers.cookie || "";

    const cookies = {};

    header
        .split(";")
        .forEach(part => {
            const index =
                part.indexOf("=");

            if (index === -1) {
                return;
            }

            const key =
                part
                    .slice(
                        0,
                        index
                    )
                    .trim();

            const value =
                part
                    .slice(
                        index + 1
                    )
                    .trim();

            try {
                cookies[key] =
                    decodeURIComponent(
                        value
                    );
            } catch {
                cookies[key] =
                    value;
            }
        });

    return cookies;
}

function createAdminSession() {
    const token =
        crypto
            .randomBytes(32)
            .toString("hex");

    sessions.set(
        token,
        {
            createdAt:
                Date.now()
        }
    );

    return token;
}

function isValidAdminSession(
    req
) {
    const cookies =
        parseCookies(req);

    const token =
        cookies[ADMIN_COOKIE];

    if (!token) {
        return false;
    }

    const session =
        sessions.get(token);

    if (!session) {
        return false;
    }

    if (
        Date.now() -
        session.createdAt >
        SESSION_TIME
    ) {
        sessions.delete(
            token
        );

        return false;
    }

    return true;
}

function requireAdmin(
    req,
    res,
    next
) {
    if (
        !isValidAdminSession(
            req
        )
    ) {
        return res
            .status(401)
            .json({
                success: false,
                message:
                    "Admin login required"
            });
    }

    next();
}

/* =========================================================
   ADMIN LOGIN
========================================================= */

app.post(
    "/api/admin/login",
    (req, res) => {
        try {
            const password =
                String(
                    req.body.password ||
                    ""
                ).trim();

            if (!password) {
                return res
                    .status(400)
                    .json({
                        success: false,
                        message:
                            "Password is required"
                    });
            }

            if (
                password !==
                ADMIN_PASSWORD
            ) {
                return res
                    .status(401)
                    .json({
                        success: false,
                        message:
                            "Incorrect admin password"
                    });
            }

            const token =
                createAdminSession();

            res.setHeader(
                "Set-Cookie",
                `${ADMIN_COOKIE}=${token}; HttpOnly; Path=/; SameSite=None; Secure; Max-Age=${SESSION_TIME / 1000}`
            );

            return res.json({
                success: true,
                message:
                    "Admin login successful"
            });
        } catch (error) {
            console.error(
                "ADMIN LOGIN ERROR:",
                error
            );

            return res
                .status(500)
                .json({
                    success: false,
                    message:
                        "Login server error"
                });
        }
    }
);

/* =========================================================
   ADMIN LOGOUT
========================================================= */

app.post(
    "/api/admin/logout",
    (req, res) => {
        const cookies =
            parseCookies(req);

        const token =
            cookies[ADMIN_COOKIE];

        if (token) {
            sessions.delete(
                token
            );
        }

        res.setHeader(
            "Set-Cookie",
            `${ADMIN_COOKIE}=; HttpOnly; Path=/; SameSite=None; Secure; Max-Age=0`
        );

        res.json({
            success: true
        });
    }
);

/* =========================================================
   ADMIN SESSION
========================================================= */

app.get(
    "/api/admin/session",
    (req, res) => {
        res.json({
            success: true,

            loggedIn:
                isValidAdminSession(
                    req
                )
        });
    }
);

/* =========================================================
   MAIN LIVE PRODUCT API
========================================================= */

app.get(
    "/api/products",
    async (req, res) => {
        try {
            const page =
                Math.max(
                    1,
                    Number(
                        req.query.page ||
                        1
                    )
                );

            const size =
                Math.min(
                    100,
                    Math.max(
                        1,
                        Number(
                            req.query.size ||
                            100
                        )
                    )
                );

            const keyword =
                String(
                    req.query.keyword ||
                    req.query.search ||
                    ""
                ).trim();

            const categoryId =
                String(
                    req.query.categoryId ||
                    ""
                ).trim();

            const countryCode =
                String(
                    req.query.countryCode ||
                    ""
                ).trim();

            /*
             * LIVE CJ REQUEST.
             *
             * This is the Vercel fix.
             */

            const result =
                await fetchCJProductPage({
                    page,
                    size,
                    keyword,
                    categoryId,
                    countryCode
                });

            return res.json({
                success: true,

                source:
                    "cjdropshipping-live",

                products:
                    result.products,

                total:
                    result.total,

                page:
                    result.page,

                size:
                    result.size,

                totalPages:
                    result.totalPages,

                catalogUpdatedAt:
                    new Date().toISOString(),

                lastSync:
                    new Date().toISOString()
            });
        } catch (error) {
            console.error(
                "LIVE PRODUCT API ERROR:",
                error
            );

            return res
                .status(500)
                .json({
                    success: false,

                    message:
                        "Could not load CJ products",

                    error:
                        process.env.NODE_ENV ===
                        "development"
                            ? error.message
                            : undefined
                });
        }
    }
);

/* =========================================================
   CJ PRODUCTS COMPATIBILITY API
========================================================= */

app.get(
    "/api/cj-products",
    async (req, res) => {
        try {
            const page =
                Math.max(
                    1,
                    Number(
                        req.query.page ||
                        1
                    )
                );

            const size =
                Math.min(
                    100,
                    Math.max(
                        1,
                        Number(
                            req.query.size ||
                            100
                        )
                    )
                );

            const keyword =
                String(
                    req.query.keyword ||
                    req.query.search ||
                    ""
                ).trim();

            const categoryId =
                String(
                    req.query.categoryId ||
                    ""
                ).trim();

            const result =
                await fetchCJProductPage({
                    page,
                    size,
                    keyword,
                    categoryId
                });

            return res.json({
                success: true,

                source:
                    "cjdropshipping-live",

                products:
                    result.products,

                total:
                    result.total,

                page:
                    result.page,

                size:
                    result.size,

                totalPages:
                    result.totalPages
            });
        } catch (error) {
            console.error(
                "CJ PRODUCTS API ERROR:",
                error
            );

            return res
                .status(500)
                .json({
                    success: false,
                    message:
                        "Could not load CJ products"
                });
        }
    }
);

/* =========================================================
   CATALOG STATUS
========================================================= */

/*
 * Keep the old endpoint.
 */

app.get(
    "/api/products/status",
    async (req, res) => {
        try {
            const result =
                await fetchCJProductPage({
                    page: 1,
                    size: 1
                });

            res.json({
                success: true,

                source:
                    "cjdropshipping-live",

                totalProducts:
                    result.total,

                availableProducts:
                    result.total,

                totalPages:
                    result.totalPages,

                syncRunning:
                    productSyncRunning,

                catalogUpdatedAt:
                    new Date().toISOString(),

                lastSync:
                    new Date().toISOString()
            });
        } catch (error) {
            console.error(
                "CATALOG STATUS ERROR:",
                error
            );

            res.status(500).json({
                success: false,

                message:
                    "Could not load catalog status",

                error:
                    error.message
            });
        }
    }
);

/*
 * ADD THIS ENDPOINT TOO.
 *
 * This fixes the 404 you were seeing.
 */

app.get(
    "/api/catalog-status",
    async (req, res) => {
        try {
            const result =
                await fetchCJProductPage({
                    page: 1,
                    size: 1
                });

            res.json({
                success: true,

                source:
                    "cjdropshipping-live",

                totalProducts:
                    result.total,

                availableProducts:
                    result.total,

                totalPages:
                    result.totalPages,

                syncRunning:
                    productSyncRunning,

                catalogUpdatedAt:
                    new Date().toISOString(),

                lastSync:
                    new Date().toISOString()
            });
        } catch (error) {
            console.error(
                "CATALOG STATUS ERROR:",
                error
            );

            res.status(500).json({
                success: false,

                message:
                    "Could not load catalog status",

                error:
                    error.message
            });
        }
    }
);

/* =========================================================
   ADMIN MANUAL PRODUCT SYNC
========================================================= */

app.post(
    "/api/admin/sync-products",
    requireAdmin,
    async (req, res) => {
        try {
            const result =
                await syncCJProducts();

            return res.json(
                result
            );
        } catch (error) {
            console.error(
                "ADMIN PRODUCT SYNC ERROR:",
                error
            );

            return res
                .status(500)
                .json({
                    success: false,

                    message:
                        error.message ||
                        "Product synchronization failed"
                });
        }
    }
);

/* =========================================================
   ADMIN PRODUCT CATALOG
========================================================= */

app.get(
    "/api/admin/products",
    requireAdmin,
    (req, res) => {
        try {
            const catalog =
                readCatalog();

            return res.json({
                success: true,

                count:
                    catalog.products.length,

                updatedAt:
                    catalog.updatedAt,

                lastSync:
                    catalog.lastSync,

                products:
                    catalog.products
            });
        } catch (error) {
            console.error(
                "ADMIN PRODUCT ERROR:",
                error
            );

            return res
                .status(500)
                .json({
                    success: false,

                    message:
                        "Could not load product catalog"
                });
        }
    }
);

/* =========================================================
   CUSTOMER CREATE ORDER
========================================================= */

app.post(
    "/api/orders",
    (req, res) => {
        try {
            const body =
                req.body || {};

            const order = {
                id:
                    crypto.randomUUID(),

                orderNumber:
                    body.orderNumber ||
                    generateOrderNumber(),

                createdAt:
                    body.createdAt ||
                    new Date().toISOString(),

                customer: {
                    name:
                        body.customer?.name ||
                        body.customerName ||
                        "",

                    email:
                        body.customer?.email ||
                        body.customerEmail ||
                        "",

                    phone:
                        body.customer?.phone ||
                        body.customerPhone ||
                        ""
                },

                shippingAddress:
                    body.shippingAddress ||
                    body.address ||
                    {},

                items:
                    Array.isArray(
                        body.items
                    )
                        ? body.items
                        : [],

                total:
                    Number(
                        body.total ||
                        body.amount ||
                        0
                    ),

                currency:
                    body.currency ||
                    DEFAULT_CURRENCY,

                status:
                    "PAYMENT_PENDING",

                paymentStatus:
                    "PENDING",

                cjPaymentStatus:
                    "NOT_CREATED",

                cjOrderId:
                    null,

                cjStatus:
                    null,

                trackingNumber:
                    null,

                notes: [],

                rawCustomerOrder:
                    body
            };

            const orders =
                readOrders();

            orders.unshift(
                order
            );

            saveOrders(
                orders
            );

            console.log(
                "NEW GLOBIRA ORDER:",
                order.orderNumber
            );

            return res
                .status(201)
                .json({
                    success: true,

                    message:
                        "Order created successfully",

                    order
                });
        } catch (error) {
            console.error(
                "CREATE ORDER ERROR:",
                error
            );

            return res
                .status(500)
                .json({
                    success: false,

                    message:
                        "Could not create order"
                });
        }
    }
);

/* =========================================================
   GET CUSTOMER ORDER
========================================================= */

app.get(
    "/api/orders/:orderNumber",
    (req, res) => {
        const orders =
            readOrders();

        const order =
            orders.find(
                item =>
                    item.orderNumber ===
                    req.params.orderNumber
            );

        if (!order) {
            return res
                .status(404)
                .json({
                    success: false,

                    message:
                        "Order not found"
                });
        }

        res.json({
            success: true,
            order
        });
    }
);

/* =========================================================
   ADMIN ALL ORDERS
========================================================= */

app.get(
    "/api/admin/orders",
    requireAdmin,
    (req, res) => {
        try {
            const orders =
                readOrders();

            return res.json({
                success: true,

                count:
                    orders.length,

                orders
            });
        } catch (error) {
            console.error(
                "ADMIN ORDERS ERROR:",
                error
            );

            return res
                .status(500)
                .json({
                    success: false,

                    message:
                        "Could not load orders"
                });
        }
    }
);

/* =========================================================
   ADMIN CONFIRM PAYMENT
========================================================= */

app.post(
    "/api/admin/orders/:id/confirm-payment",
    requireAdmin,
    (req, res) => {
        try {
            const orders =
                readOrders();

            const order =
                orders.find(
                    item =>
                        item.id ===
                            req.params.id ||
                        item.orderNumber ===
                            req.params.id
                );

            if (!order) {
                return res
                    .status(404)
                    .json({
                        success: false,

                        message:
                            "Order not found"
                    });
            }

            order.paymentStatus =
                "CONFIRMED";

            order.status =
                "PROCESSING";

            order.notes =
                Array.isArray(
                    order.notes
                )
                    ? order.notes
                    : [];

            order.notes.push({
                time:
                    new Date().toISOString(),

                message:
                    "Customer payment manually confirmed by GLOBIRA admin."
            });

            saveOrders(
                orders
            );

            return res.json({
                success: true,

                message:
                    "Customer payment confirmed",

                order
            });
        } catch (error) {
            console.error(
                "CONFIRM PAYMENT ERROR:",
                error
            );

            return res
                .status(500)
                .json({
                    success: false,

                    message:
                        "Could not confirm payment"
                });
        }
    }
);

/* =========================================================
   ADMIN CANCEL ORDER
========================================================= */

app.post(
    "/api/admin/orders/:id/cancel",
    requireAdmin,
    (req, res) => {
        try {
            const orders =
                readOrders();

            const order =
                orders.find(
                    item =>
                        item.id ===
                            req.params.id ||
                        item.orderNumber ===
                            req.params.id
                );

            if (!order) {
                return res
                    .status(404)
                    .json({
                        success: false,

                        message:
                            "Order not found"
                    });
            }

            order.status =
                "CANCELLED";

            order.notes =
                Array.isArray(
                    order.notes
                )
                    ? order.notes
                    : [];

            order.notes.push({
                time:
                    new Date().toISOString(),

                message:
                    "Order cancelled by GLOBIRA admin."
            });

            saveOrders(
                orders
            );

            return res.json({
                success: true,

                message:
                    "Order cancelled",

                order
            });
        } catch (error) {
            console.error(
                "CANCEL ERROR:",
                error
            );

            return res
                .status(500)
                .json({
                    success: false,

                    message:
                        "Could not cancel order"
                });
        }
    }
);

/* =========================================================
   SEND ORDER TO CJ
   NO CJ PAYMENT
========================================================= */

app.post(
    "/api/admin/orders/:id/send-to-cj",
    requireAdmin,
    async (req, res) => {
        try {
            const orders =
                readOrders();

            const order =
                orders.find(
                    item =>
                        item.id ===
                            req.params.id ||
                        item.orderNumber ===
                            req.params.id
                );

            if (!order) {
                return res
                    .status(404)
                    .json({
                        success: false,

                        message:
                            "Order not found"
                    });
            }

            if (
                order.paymentStatus !==
                "CONFIRMED"
            ) {
                return res
                    .status(400)
                    .json({
                        success: false,

                        message:
                            "Customer payment must be confirmed before sending to CJ."
                    });
            }

            order.status =
                "CJ_PENDING";

            order.cjPaymentStatus =
                "UNPAID";

            order.notes =
                Array.isArray(
                    order.notes
                )
                    ? order.notes
                    : [];

            order.notes.push({
                time:
                    new Date().toISOString(),

                message:
                    "Order prepared for CJ. CJ payment remains unpaid and must be handled manually."
            });

            saveOrders(
                orders
            );

            return res.json({
                success: true,

                message:
                    "Order prepared for CJ. No CJ payment was made.",

                order
            });
        } catch (error) {
            console.error(
                "SEND TO CJ ERROR:",
                error
            );

            return res
                .status(500)
                .json({
                    success: false,

                    message:
                        "Could not prepare order for CJ"
                });
        }
    }
);

/* =========================================================
   CJ ORDER SYNC PLACEHOLDER
========================================================= */

app.post(
    "/api/admin/orders/:id/sync-cj",
    requireAdmin,
    (req, res) => {
        try {
            const orders =
                readOrders();

            const order =
                orders.find(
                    item =>
                        item.id ===
                            req.params.id ||
                        item.orderNumber ===
                            req.params.id
                );

            if (!order) {
                return res
                    .status(404)
                    .json({
                        success: false,

                        message:
                            "Order not found"
                    });
            }

            return res.json({
                success: true,

                message:
                    "CJ sync endpoint is working.",

                order
            });
        } catch (error) {
            console.error(
                "CJ SYNC ERROR:",
                error
            );

            return res
                .status(500)
                .json({
                    success: false,

                    message:
                        "CJ sync failed"
                });
        }
    }
);

/* =========================================================
   TEST
========================================================= */

app.get(
    "/api/test",
    (req, res) => {
        const catalog =
            readCatalog();

        res.json({
            success: true,

            message:
                "GLOBIRA SERVER IS WORKING",

            time:
                new Date().toISOString(),

            cj:
                CJ_ACCESS_TOKEN ||
                CJ_API_KEY
                    ? "CONFIGURED"
                    : "MISSING",

            catalog: {
                products:
                    catalog.products.length,

                updatedAt:
                    catalog.updatedAt,

                lastSync:
                    catalog.lastSync
            }
        });
    }
);

/* =========================================================
   FRONTEND
========================================================= */

app.use(
    express.static(ROOT)
);

app.get(
    "/admin",
    (req, res) => {
        res.sendFile(
            path.join(
                ROOT,
                "admin.html"
            )
        );
    }
);

app.get(
    "/",
    (req, res) => {
        res.sendFile(
            path.join(
                ROOT,
                "index.html"
            )
        );
    }
);

/* =========================================================
   API 404
========================================================= */

app.use(
    "/api",
    (req, res) => {
        res
            .status(404)
            .json({
                success: false,

                message:
                    "API route not found"
            });
    }
);

/* =========================================================
   GENERAL ERROR
========================================================= */

app.use(
    (
        err,
        req,
        res,
        next
    ) => {
        console.error(
            "SERVER ERROR:",
            err
        );

        res
            .status(500)
            .json({
                success: false,

                message:
                    err.message ||
                    "Internal server error"
            });
    }
);

/* =========================================================
   LOCAL SERVER
========================================================= */

/*
 * IMPORTANT:
 *
 * Vercel imports this file as a serverless function.
 * Therefore app.listen() is ONLY used locally.
 */

if (
    require.main === module
) {
    ensureOrdersFile();
    ensureCatalogFile();

    app.listen(
        PORT,
        () => {
            console.log("");
            console.log(
                "===================================="
            );
            console.log(
                "          GLOBIRA SERVER"
            );
            console.log(
                "===================================="
            );

            console.log(
                `PORT: ${PORT}`
            );

            console.log(
                `ADMIN: http://localhost:${PORT}/admin`
            );

            console.log(
                `HOME: http://localhost:${PORT}/`
            );

            console.log(
                `CJ TOKEN: ${
                    CJ_ACCESS_TOKEN
                        ? "CONFIGURED"
                        : CJ_API_KEY
                            ? "API KEY CONFIGURED"
                            : "MISSING"
                }`
            );

            console.log(
                `MARKUP: ${GLOBIRA_MARKUP_PERCENT}%`
            );

            console.log(
                "LIVE CJ PRODUCTS: ENABLED"
            );

            console.log(
                "===================================="
            );

            console.log("");
        }
    );
}

/* =========================================================
   VERCEL EXPORT
========================================================= */

module.exports = app;
