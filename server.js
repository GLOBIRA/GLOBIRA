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
   SUPPLIER SETTINGS
========================================================= */

const CJ_ACCESS_TOKEN = String(
    process.env.CJ_ACCESS_TOKEN || ""
).trim();

const CJ_API_KEY = String(
    process.env.CJ_API_KEY || ""
).trim();

const CJ_API_BASE =
    "https://developers.cjdropshipping.com/api2.0/v1";

const CJ_PRODUCT_LIST_URL =
    `${CJ_API_BASE}/product/listV2`;

const CJ_PAGE_SIZE = 100;

const GLOBIRA_MARKUP_PERCENT = Math.max(
    0,
    Number(
        process.env.GLOBIRA_MARKUP_PERCENT || 60
    )
);

const DEFAULT_CURRENCY =
    process.env.DEFAULT_CURRENCY || "USD";

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

function uniqueStrings(values) {
    return [
        ...new Set(
            safeArray(values)
                .map(value =>
                    String(value || "").trim()
                )
                .filter(Boolean)
        )
    ];
}

function cleanProductText(value) {
    return String(value || "")
        .replace(/<[^>]*>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
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
========================================================= */

function emptyCatalog() {
    return {
        version: 1,
        updatedAt: null,
        lastSync: null,
        syncSource: "GLOBIRA",
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

    catalog.syncSource =
        "GLOBIRA";

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
   GLOBIRA PRODUCT TYPE DETECTION
========================================================= */

function detectGlobiraProductType(product) {
    const text = cleanProductText(
        [
            product?.nameEn,
            product?.productNameEn,
            product?.name,
            product?.productName,
            product?.categoryName,
            product?.oneCategoryName,
            product?.twoCategoryName,
            product?.threeCategoryName,
            product?.category,
            product?.description
        ].join(" ")
    );

    /* SHOES */

    if (
        /\b(
            shoe|shoes|sneaker|sneakers|trainer|trainers|
            boots|boot|sandals|sandal|slipper|slippers|
            loafer|loafers|heels|heel|footwear
        )\b/x.test(text)
    ) {
        return "shoes";
    }

    /* BAGS */

    if (
        /\b(
            handbag|hand bag|purse|bag|bags|backpack|
            backpacks|rucksack|tote|shoulder bag|
            crossbody|cross-body|clutch|pouch|
            laptop bag|travel bag|duffel|duffle|
            suitcase|briefcase|card holder|wallet
        )\b/x.test(text)
    ) {
        if (
            /\b(
                wallet|purse|card holder|cardholder|money clip
            )\b/x.test(text)
        ) {
            return "wallets";
        }

        return "bags";
    }

    /* JEWELRY */

    if (
        /\b(
            ring|rings|bracelet|bracelets|necklace|
            necklaces|chain|chains|earring|earrings|
            pendant|pendants|jewelry|jewellery|
            anklet|anklets
        )\b/x.test(text)
    ) {
        if (
            /\b(ring|rings)\b/.test(text)
        ) {
            return "rings";
        }

        if (
            /\b(
                bracelet|bracelets|anklet|anklets
            )\b/x.test(text)
        ) {
            return "bracelets";
        }

        if (
            /\b(
                necklace|necklaces|chain|chains|
                pendant|pendants
            )\b/x.test(text)
        ) {
            return "necklaces";
        }

        return "jewelry";
    }

    /* ELECTRONICS */

    if (
        /\b(
            phone|mobile|iphone|samsung|xiaomi|redmi|
            oppo|vivo|realme|case|phone case|tablet|
            ipad|laptop|computer|keyboard|mouse|
            headphone|headphones|earphone|earphones|
            earbud|earbuds|airpods|speaker|speakers|
            charger|charging|cable|power bank|powerbank|
            smart watch|smartwatch|watch|camera|
            projector|monitor|usb|adapter|hub|
            electronic|electronics|gamepad|controller|
            console
        )\b/x.test(text)
    ) {
        return "electronics";
    }

    /* KIDS */

    if (
        /\b(
            baby|babies|infant|infants|kid|kids|child|
            children|toddler|newborn|boy|girls|girl|boys
        )\b/x.test(text)
    ) {
        return "kids";
    }

    /* CLOTHING */

    if (
        /\b(
            t-shirt|tshirt|tee|shirt|shirts|polo|
            hoodie|hoodies|sweatshirt|sweatshirts|
            jacket|jackets|coat|coats|blazer|blazers|
            dress|dresses|skirt|skirts|legging|leggings|
            shorts|pants|trousers|jeans|joggers|
            tracksuit|tracksuits|sweatpants|underwear|
            briefs|boxers|bra|bras|lingerie|swimwear|
            bikini|bikinis|bodysuit|jumpsuit|romper|
            top|tops|cardigan|vest|waistcoat|
            clothing|apparel
        )\b/x.test(text)
    ) {
        if (
            /\b(
                jeans|pants|trousers|joggers|
                sweatpants|shorts
            )\b/x.test(text)
        ) {
            return "pants";
        }

        return "clothing";
    }

    /* HOME */

    if (
        /\b(
            kitchen|cookware|tableware|home decor|
            decoration|storage|organizer|organiser|
            furniture|chair|table|shelf|shelves|
            pillow|cushion|blanket|towel|bedding|
            bathroom|home
        )\b/x.test(text)
    ) {
        return "home";
    }

    /* BEAUTY */

    if (
        /\b(
            makeup|cosmetic|cosmetics|lipstick|foundation|
            mascara|eyeliner|beauty|skincare|cream|
            serum|lotion|shampoo|conditioner|perfume|
            fragrance|brush|beauty tool
        )\b/x.test(text)
    ) {
        return "beauty";
    }

    /* SPORTS */

    if (
        /\b(
            sports|sport|fitness|gym|yoga|football|
            soccer|basketball|tennis|cycling|cycling gear|
            gloves|sportswear
        )\b/x.test(text)
    ) {
        return "sports";
    }

    return "other";
}

/* =========================================================
   SIZE CONFIGURATION
========================================================= */

function getGlobiraSizeConfiguration(
    productType
) {
    const config = {
        enabled: false,
        type: "none",
        label: "",
        system: "",
        chartType: "none",
        attributes: [],
        note: ""
    };

    if (productType === "clothing") {
        return {
            enabled: true,
            type: "clothing",
            label: "Size",
            system: "standard_clothing",
            chartType: "clothing",
            attributes: [
                "chest",
                "shoulder",
                "length",
                "sleeve"
            ],
            note:
                "Only sizes actually available from the supplier are shown."
        };
    }

    if (productType === "pants") {
        return {
            enabled: true,
            type: "pants",
            label: "Waist / Size",
            system: "waist",
            chartType: "pants",
            attributes: [
                "waist",
                "hip",
                "inseam",
                "length",
                "rise"
            ],
            note:
                "Pants use the supplier's actual waist or size measurements."
        };
    }

    if (productType === "shoes") {
        return {
            enabled: true,
            type: "shoes",
            label: "Shoe Size",
            system: "shoe",
            chartType: "shoes",
            attributes: [
                "EU",
                "US",
                "UK",
                "footLengthCm"
            ],
            note:
                "Only actual available shoe sizes are shown."
        };
    }

    if (productType === "kids") {
        return {
            enabled: true,
            type: "kids",
            label: "Age / Size",
            system: "kids",
            chartType: "kids",
            attributes: [
                "age",
                "height",
                "chest",
                "waist",
                "hip"
            ],
            note:
                "Kids sizes follow the available supplier variants."
        };
    }

    if (productType === "rings") {
        return {
            enabled: true,
            type: "ring",
            label: "Ring Size",
            system: "ring",
            chartType: "ring",
            attributes: [
                "US",
                "UK",
                "EU",
                "diameterMm",
                "circumferenceMm"
            ],
            note:
                "Ring sizing follows the supplier's available variants."
        };
    }

    if (productType === "bracelets") {
        return {
            enabled: true,
            type: "bracelet",
            label: "Bracelet Size",
            system: "length",
            chartType: "bracelet",
            attributes: [
                "length",
                "wristCircumference"
            ],
            note:
                "Bracelet length is used instead of clothing sizing."
        };
    }

    if (productType === "necklaces") {
        return {
            enabled: true,
            type: "necklace",
            label: "Length",
            system: "length",
            chartType: "necklace",
            attributes: [
                "length",
                "extension"
            ],
            note:
                "Necklace length is used instead of clothing sizing."
        };
    }

    /* BAGS NEVER GET CLOTHING SIZE */

    if (productType === "bags") {
        return {
            enabled: false,
            type: "dimensions",
            label: "",
            system: "dimensions",
            chartType: "bag_dimensions",
            attributes: [
                "width",
                "height",
                "depth",
                "strapLength",
                "handleDrop"
            ],
            note:
                "This product uses dimensions instead of clothing size."
        };
    }

    if (productType === "wallets") {
        return {
            enabled: false,
            type: "dimensions",
            label: "",
            system: "dimensions",
            chartType: "wallet_dimensions",
            attributes: [
                "width",
                "height",
                "thickness"
            ],
            note:
                "This product uses dimensions instead of clothing size."
        };
    }

    /* ELECTRONICS NEVER GET CLOTHING SIZE */

    if (productType === "electronics") {
        return {
            enabled: false,
            type: "variant",
            label: "Variant",
            system: "product_variant",
            chartType: "none",
            attributes: [
                "model",
                "compatibility",
                "capacity",
                "power",
                "color"
            ],
            note:
                "Electronics use model, compatibility, capacity or technical variants."
        };
    }

    if (productType === "home") {
        return {
            enabled: false,
            type: "dimensions",
            label: "",
            system: "dimensions",
            chartType: "home_dimensions",
            attributes: [
                "length",
                "width",
                "height",
                "capacity",
                "weight"
            ],
            note:
                "Home products use dimensions, capacity or weight."
        };
    }

    if (productType === "beauty") {
        return {
            enabled: false,
            type: "variant",
            label: "Variant",
            system: "beauty_variant",
            chartType: "none",
            attributes: [
                "shade",
                "volume",
                "capacity",
                "packQuantity"
            ],
            note:
                "Beauty products use shade, volume or pack quantity."
        };
    }

    if (productType === "sports") {
        return {
            enabled: false,
            type: "sport_variant",
            label: "Variant",
            system: "sport",
            chartType: "none",
            attributes: [
                "size",
                "dimensions",
                "weight",
                "capacity"
            ],
            note:
                "Sports products use product-specific measurements."
        };
    }

    return config;
}

/* =========================================================
   VARIANT NORMALIZATION
========================================================= */

function extractVariantText(variant) {
    if (!variant) {
        return "";
    }

    if (typeof variant === "string") {
        return variant;
    }

    return [
        variant.variantName,
        variant.variantNameEn,
        variant.name,
        variant.nameEn,
        variant.variant,
        variant.size,
        variant.sizeName,
        variant.color,
        variant.colorName,
        variant.colorNameEn,
        variant.sku,
        variant.variantSku
    ]
        .filter(Boolean)
        .join(" / ");
}

function normalizeCJVariants(product) {
    const rawVariants = [
        ...safeArray(product?.variants),
        ...safeArray(product?.variantList),
        ...safeArray(product?.productVariants)
    ];

    const unique = new Map();

    for (const raw of rawVariants) {
        if (!raw) {
            continue;
        }

        const text =
            extractVariantText(raw);

        const sku =
            String(
                raw?.sku ||
                raw?.variantSku ||
                raw?.variantId ||
                raw?.vid ||
                ""
            ).trim();

        const id =
            String(
                raw?.variantId ||
                raw?.vid ||
                sku ||
                text
            ).trim();

        if (!id && !text) {
            continue;
        }

        const variant = {
            id:
                id ||
                `variant_${unique.size + 1}`,

            sku,

            name:
                text ||
                sku,

            available:
                raw?.available !== false &&
                raw?.stock !== 0 &&
                raw?.inventory !== 0,

            stock:
                Math.max(
                    0,
                    Number(
                        raw?.stock ??
                        raw?.inventory ??
                        raw?.inventoryNum ??
                        0
                    )
                ),

            color:
                raw?.color ||
                raw?.colorName ||
                raw?.colorNameEn ||
                "",

            size:
                raw?.size ||
                raw?.sizeName ||
                "",

            price:
                Number(
                    raw?.price ??
                    raw?.sellPrice ??
                    raw?.discountPrice ??
                    0
                ),

            raw
        };

        unique.set(
            variant.id,
            variant
        );
    }

    return Array.from(
        unique.values()
    );
}

/* =========================================================
   SIZE EXTRACTION
========================================================= */

function extractActualSizes(
    productType,
    variants
) {
    const values = [];

    for (const variant of variants) {
        const size =
            String(
                variant.size || ""
            ).trim();

        if (size) {
            values.push(size);
            continue;
        }

        const raw =
            variant.raw || {};

        const rawSize =
            raw.size ||
            raw.sizeName ||
            raw.sizeNameEn ||
            raw.optionSize ||
            "";

        if (rawSize) {
            values.push(
                String(rawSize).trim()
            );
        }
    }

    /*
     * Fallback for variants such as:
     *
     * Black-M
     * White-XL
     * Blue-42
     */

    if (
        !values.length &&
        (
            productType === "clothing" ||
            productType === "pants" ||
            productType === "shoes" ||
            productType === "kids" ||
            productType === "rings"
        )
    ) {
        for (const variant of variants) {
            const text =
                String(
                    variant.name || ""
                ).trim();

            if (!text) {
                continue;
            }

            const parts =
                text
                    .split(
                        /[-|,/]+/
                    )
                    .map(
                        item =>
                            item.trim()
                    )
                    .filter(Boolean);

            for (const part of parts) {
                if (
                    /^(xxxs|xxs|xs|s|m|l|xl|xxl|2xl|3xl|4xl|5xl|\d{1,3}(?:\.\d+)?)$/i
                        .test(part)
                ) {
                    values.push(part);
                }
            }
        }
    }

    return uniqueStrings(values);
}

/* =========================================================
   COLOR EXTRACTION
========================================================= */

function extractActualColors(
    variants
) {
    const colors = [];

    for (const variant of variants) {
        if (variant.color) {
            colors.push(
                variant.color
            );
        }

        const raw =
            variant.raw || {};

        colors.push(
            raw.color,
            raw.colorName,
            raw.colorNameEn,
            raw.colour,
            raw.colourName
        );
    }

    return uniqueStrings(
        colors
    );
}

/* =========================================================
   DIMENSIONS
========================================================= */

function extractProductDimensions(
    product
) {
    return {
        length:
            product?.length ||
            product?.productLength ||
            product?.lengthCm ||
            null,

        width:
            product?.width ||
            product?.productWidth ||
            product?.widthCm ||
            null,

        height:
            product?.height ||
            product?.productHeight ||
            product?.heightCm ||
            null,

        depth:
            product?.depth ||
            product?.depthCm ||
            null,

        weight:
            product?.weight ||
            product?.productWeight ||
            product?.weightGram ||
            null,

        capacity:
            product?.capacity ||
            product?.volume ||
            null
    };
}

/* =========================================================
   SIZE FILTER TYPE
========================================================= */

function getGlobiraFilterSizeType(
    productType
) {
    switch (productType) {
        case "clothing":
            return "clothing";

        case "pants":
            return "waist";

        case "shoes":
            return "shoe";

        case "kids":
            return "kids";

        case "rings":
            return "ring";

        case "bracelets":
            return "bracelet";

        case "necklaces":
            return "necklace";

        default:
            return "none";
    }
}

/* =========================================================
   PUBLIC PRODUCT NORMALIZATION
 *
 * IMPORTANT:
 *
 * No supplier branding is returned here.
 * Customer-facing data uses GLOBIRA.
 *
 * Internal supplier information remains available
 * only where needed by backend order processing.
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
        MIN_PRODUCT_STOCK,
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

    const available =
        supplierCost > 0 &&
        (
            stock > 0 ||
            (
                product.inventory === undefined &&
                product.warehouseInventoryNum === undefined &&
                product.totalVerifiedInventory === undefined
            )
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

    /* IMAGES */

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
        images.unshift(
            mainImage
        );
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

    /* CATEGORY */

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

    /* PRODUCT TYPE */

    const productType =
        detectGlobiraProductType(
            product
        );

    /* VARIANTS */

    const normalizedVariants =
        normalizeCJVariants(
            product
        );

    /* SIZE */

    const sizeConfig =
        getGlobiraSizeConfiguration(
            productType
        );

    const actualSizes =
        extractActualSizes(
            productType,
            normalizedVariants
        );

    const actualColors =
        extractActualColors(
            normalizedVariants
        );

    const dimensions =
        extractProductDimensions(
            product
        );

    /* PRICE */

    const globiraPrice =
        calculateGlobiraPrice(
            supplierCost
        );

    /*
     * INTERNAL SUPPLIER IDENTIFIERS
     *
     * These are required by the backend to know
     * which product/variant must eventually be
     * ordered from the supplier.
     */

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

    /*
     * PUBLIC PRODUCT OBJECT
     *
     * No supplier name.
     * No supplier branding.
     */

    return {
        id:
            `product_${supplierProductId || supplierSku}`,

        productId:
            supplierProductId,

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

        brand:
            product.brand ||
            "GLOBIRA",

        storeName:
            "GLOBIRA",

        productType,

        sizeType:
            getGlobiraFilterSizeType(
                productType
            ),

        sizeConfig,

        sizeOptions:
            actualSizes,

        hasSizeSelector:
            sizeConfig.enabled &&
            actualSizes.length > 0,

        colorOptions:
            actualColors,

        dimensions,

        variants:
            normalizedVariants,

        variantCount:
            normalizedVariants.length,

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
            new Date().toISOString(),

        /*
         * INTERNAL DATA
         *
         * Kept inside a clearly separated object.
         * Frontend should not display this.
         */
        _internal: {
            supplierProductId,
            supplierSku,
            supplier: "supplier"
        }
    };
}

/* =========================================================
   CJ TOKEN / REQUEST
========================================================= */

async function getCJAccessToken() {
    if (CJ_ACCESS_TOKEN) {
        return CJ_ACCESS_TOKEN;
    }

    if (!CJ_API_KEY) {
        throw new Error(
            "Supplier access credentials are not configured."
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
            `Supplier authentication returned invalid JSON. HTTP ${response.status}`
        );
    }

    if (
        !response.ok ||
        data.result === false ||
        data.success === false
    ) {
        throw new Error(
            `Supplier authentication failed: ${
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
            "Supplier authentication succeeded but no access token was returned."
        );
    }

    return token;
}

async function cjGET(url) {
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
            `Supplier API returned invalid JSON. HTTP ${response.status}`
        );
    }

    if (!response.ok) {
        throw new Error(
            `Supplier API HTTP ${response.status}: ${
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
            `Supplier API error: ${
                data.message ||
                "Request failed"
            }`
        );
    }

    return data;
}

/* =========================================================
   LIVE PRODUCT REQUEST
========================================================= */

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

    const unique =
        new Map();

    for (
        const product of products
    ) {
        const key =
            product.productId ||
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
                    `Product sync page ${page}: ${result.products.length} products`
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
                    `Product sync page ${page} failed:`,
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
                product.productId ||
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
                "GLOBIRA",

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
                            product.subCategory
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
                    "globira-live",

                brand:
                    "GLOBIRA",

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
                        "Could not load products",

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
   COMPATIBILITY PRODUCT API
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
                    "globira-live",

                brand:
                    "GLOBIRA",

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
                "PRODUCT API ERROR:",
                error
            );

            return res
                .status(500)
                .json({
                    success: false,
                    message:
                        "Could not load products"
                });
        }
    }
);

/* =========================================================
   CATALOG STATUS
========================================================= */

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
                    "globira-live",

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
                    "Could not load catalog status"
            });
        }
    }
);

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
                    "globira-live",

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
                    "Could not load catalog status"
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
   SEND ORDER TO SUPPLIER
   NO SUPPLIER PAYMENT
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
                            "Customer payment must be confirmed before processing the order."
                    });
            }

            order.status =
                "SUPPLIER_PENDING";

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
                    "Order prepared for supplier processing. Supplier payment remains manual."
            });

            saveOrders(
                orders
            );

            return res.json({
                success: true,

                message:
                    "Order prepared for processing.",

                order
            });
        } catch (error) {
            console.error(
                "SEND TO SUPPLIER ERROR:",
                error
            );

            return res
                .status(500)
                .json({
                    success: false,

                    message:
                        "Could not prepare order"
                });
        }
    }
);

/* =========================================================
   SUPPLIER ORDER SYNC PLACEHOLDER
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
                    "Order sync endpoint is working.",

                order
            });
        } catch (error) {
            console.error(
                "ORDER SYNC ERROR:",
                error
            );

            return res
                .status(500)
                .json({
                    success: false,

                    message:
                        "Order sync failed"
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

            supplierConnection:
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
                `SUPPLIER CONNECTION: ${
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
                "LIVE PRODUCTS: ENABLED"
            );

            console.log(
                "DYNAMIC PRODUCT TYPES: ENABLED"
            );

            console.log(
                "DYNAMIC SIZE SYSTEM: ENABLED"
            );

            console.log(
                "CUSTOMER SUPPLIER BRANDING: HIDDEN"
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
