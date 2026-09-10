require("dotenv").config();

const express = require("express");
const path = require("path");
const cors = require("cors");
const crypto = require("crypto");
const fs = require("fs");

const app = express();

// ========================================
// CONFIGURATION
// ========================================

const PORT = process.env.PORT || 3000;
const SHOP_ID = 28856493;

const SUPPLIERS_FILE = path.join(__dirname, "suppliers.json");

// ========================================
// CJ DROPSHIPPING
// STEP 1: PRODUCT SYNC ONLY
// ========================================

const CJ_API_BASE =
    "https://developers.cjdropshipping.com/api2.0/v1";

let cjTokenCache = {
    accessToken: null,
    refreshToken: null,
    expiresAt: 0
};


// ========================================
// GET CJ ACCESS TOKEN
// ========================================

async function getCJAccessToken() {

    const apiKey = process.env.CJ_API_KEY;

    if (!apiKey) {
        throw new Error(
            "CJ_API_KEY is not configured in .env"
        );
    }

    // Use cached token if still valid
    if (
        cjTokenCache.accessToken &&
        Date.now() < cjTokenCache.expiresAt
    ) {
        return cjTokenCache.accessToken;
    }


    // Try refresh token first
    if (cjTokenCache.refreshToken) {

        try {

            const refreshResponse =
                await fetch(
                    `${CJ_API_BASE}/authentication/refreshAccessToken`,
                    {
                        method: "POST",

                        headers: {
                            "Content-Type":
                                "application/json"
                        },

                        body: JSON.stringify({
                            refreshToken:
                                cjTokenCache.refreshToken
                        })
                    }
                );


            const refreshJson =
                await refreshResponse.json();


            if (
                refreshResponse.ok &&
                refreshJson &&
                refreshJson.result &&
                refreshJson.data?.accessToken
            ) {

                cjTokenCache.accessToken =
                    refreshJson.data.accessToken;

                cjTokenCache.refreshToken =
                    refreshJson.data.refreshToken ||
                    cjTokenCache.refreshToken;

                cjTokenCache.expiresAt =
                    Date.now() +
                    14 * 24 * 60 * 60 * 1000;

                return cjTokenCache.accessToken;
            }

        } catch (error) {

            console.warn(
                "CJ token refresh failed:",
                error.message
            );
        }

        cjTokenCache = {
            accessToken: null,
            refreshToken: null,
            expiresAt: 0
        };
    }


    // Get new token using API key
    const authResponse =
        await fetch(
            `${CJ_API_BASE}/authentication/getAccessToken`,
            {
                method: "POST",

                headers: {
                    "Content-Type":
                        "application/json"
                },

                body: JSON.stringify({
                    apiKey: apiKey
                })
            }
        );


    const authJson =
        await authResponse.json();


    if (
        !authResponse.ok ||
        !authJson?.result ||
        !authJson?.data?.accessToken
    ) {

        throw new Error(
            authJson?.message ||
            "CJ authentication failed"
        );
    }


    cjTokenCache.accessToken =
        authJson.data.accessToken;

    cjTokenCache.refreshToken =
        authJson.data.refreshToken || null;

    cjTokenCache.expiresAt =
        Date.now() +
        14 * 24 * 60 * 60 * 1000;


    return cjTokenCache.accessToken;
}


// ========================================
// CJ GET REQUEST
// ========================================

async function cjGet(url) {

    const token =
        await getCJAccessToken();


    const response =
        await fetch(
            url,
            {
                headers: {
                    "CJ-Access-Token":
                        token
                }
            }
        );


    const json =
        await response.json();


    if (
        !response.ok ||
        json?.result === false
    ) {

        throw new Error(
            json?.message ||
            `CJ request failed (${response.status})`
        );
    }


    return json;
}


// ========================================
// NORMALIZE CJ PRODUCT
// ========================================

function normalizeCJProduct(
    product,
    details
) {

    const source =
        details ||
        product ||
        {};


    const images =
        Array.from(
            new Set(
                [
                    source.bigImage,

                    ...(Array.isArray(
                        source.productImageSet
                    )
                        ? source.productImageSet
                        : []),

                    source.productImage

                ].filter(Boolean)
            )
        );


    const rawPrice =
        Number(
            source.sellPrice ??
            product?.sellPrice ??
            0
        );


    return {

        id:
            `cj-${source.pid || source.id}`,

        cjProductId:
            source.pid ||
            source.id,

        sku:
            source.productSku ||
            source.sku ||
            "",

        name:
            source.productNameEn ||
            source.nameEn ||
            product?.productNameEn ||
            product?.nameEn ||
            "CJ Product",

        description:
            source.description ||
            product?.description ||
            "Authentic product sourced through CJdropshipping.",

        images:
            images.length
                ? images
                : [
                    "https://via.placeholder.com/900x1200?text=CJ+Product"
                ],

        // Temporary raw CJ value for Step 1
        // Existing GLOBIRA pricing UI is untouched.
        price:
            rawPrice,

        oldPrice:
            rawPrice,

        variants:
            Array.isArray(source.variants)
                ? source.variants
                : [],

        source:
            "cjdropshipping"
    };
}


// ========================================
// GET CJ PRODUCTS
// ========================================

async function getCJProducts(
    req,
    res
) {

    try {

        const keyword =
            String(
                req.query.keyword ||
                process.env.CJ_FEATURED_KEYWORD ||
                "hoodie"
            ).trim();


        const size =
            Math.min(
                Math.max(
                    Number(req.query.size) || 6,
                    1
                ),
                20
            );


        const listUrl =
            new URL(
                `${CJ_API_BASE}/product/listV2`
            );


        listUrl.searchParams.set(
            "page",
            "1"
        );


        listUrl.searchParams.set(
            "size",
            String(size)
        );


        listUrl.searchParams.set(
            "keyWord",
            keyword
        );


        listUrl.searchParams.set(
            "features",
            "enable_description,enable_category"
        );


        listUrl.searchParams.set(
            "sort",
            "desc"
        );


        listUrl.searchParams.set(
            "orderBy",
            "0"
        );


        console.log(
            "Searching CJ products:",
            keyword
        );


        const listJson =
            await cjGet(
                listUrl.toString()
            );


        const content =
            listJson?.data?.content ||
            [];


        const products =
            content.flatMap(
                item =>
                    item?.productList || []
            );


        const normalized =
            await Promise.all(

                products
                    .slice(0, size)
                    .map(
                        async product => {

                            try {

                                const detailUrl =
                                    new URL(
                                        `${CJ_API_BASE}/product/query`
                                    );


                                detailUrl.searchParams.set(
                                    "pid",
                                    product.id
                                );


                                const detailJson =
                                    await cjGet(
                                        detailUrl.toString()
                                    );


                                return normalizeCJProduct(
                                    product,
                                    detailJson?.data
                                );

                            } catch (detailError) {

                                console.warn(
                                    "CJ product detail failed:",
                                    detailError.message
                                );


                                return normalizeCJProduct(
                                    product
                                );
                            }
                        }
                    )
            );


        res.json({

            success:
                true,

            source:
                "cjdropshipping",

            keyword:
                keyword,

            products:
                normalized
        });


    } catch (error) {

        console.error(
            "CJ PRODUCTS ERROR:",
            error
        );


        res.status(500).json({

            success:
                false,

            source:
                "cjdropshipping",

            error:
                error.message
        });
    }
}


// ========================================
// GET ONE CJ PRODUCT
// ========================================

async function getCJProduct(
    req,
    res
) {

    try {

        const pid =
            String(
                req.params.productId ||
                ""
            ).replace(
                /^cj-/,
                ""
            );


        if (!pid) {

            return res
                .status(400)
                .json({

                    success:
                        false,

                    error:
                        "Missing CJ product id"
                });
        }


        const detailUrl =
            new URL(
                `${CJ_API_BASE}/product/query`
            );


        detailUrl.searchParams.set(
            "pid",
            pid
        );


        const json =
            await cjGet(
                detailUrl.toString()
            );


        res.json({

            success:
                true,

            product:
                normalizeCJProduct(
                    json?.data
                )
        });


    } catch (error) {

        console.error(
            "CJ PRODUCT ERROR:",
            error
        );


        res.status(500).json({

            success:
                false,

            error:
                error.message
        });
    }
}


// ========================================
// MIDDLEWARE
// ========================================

app.use(cors());

app.use(
    express.json()
);

app.use(
    express.urlencoded({
        extended: true
    })
);


// ========================================
// SUPPLIER DATABASE
// ========================================

function ensureSupplierFile() {

    if (
        !fs.existsSync(
            SUPPLIERS_FILE
        )
    ) {

        fs.writeFileSync(

            SUPPLIERS_FILE,

            JSON.stringify(
                [],
                null,
                2
            ),

            "utf8"
        );
    }
}


function getSuppliers() {

    ensureSupplierFile();


    try {

        const data =
            fs.readFileSync(
                SUPPLIERS_FILE,
                "utf8"
            );


        return JSON.parse(
            data
        );

    } catch (error) {

        console.error(
            "SUPPLIER DATABASE ERROR:",
            error
        );


        return [];
    }
}


function saveSuppliers(
    suppliers
) {

    fs.writeFileSync(

        SUPPLIERS_FILE,

        JSON.stringify(
            suppliers,
            null,
            2
        ),

        "utf8"
    );
}


ensureSupplierFile();


// ========================================
// PASSWORD SECURITY
// ========================================

function hashPassword(
    password
) {

    const salt =
        crypto
            .randomBytes(16)
            .toString("hex");


    const hash =
        crypto
            .pbkdf2Sync(
                password,
                salt,
                100000,
                64,
                "sha512"
            )
            .toString("hex");


    return {

        salt:
            salt,

        hash:
            hash
    };
}


function verifyPassword(
    password,
    storedHash,
    salt
) {

    const hash =
        crypto
            .pbkdf2Sync(
                password,
                salt,
                100000,
                64,
                "sha512"
            )
            .toString("hex");


    return crypto.timingSafeEqual(

        Buffer.from(
            hash,
            "hex"
        ),

        Buffer.from(
            storedHash,
            "hex"
        )
    );
}


// ========================================
// SESSION SYSTEM
// ========================================

const sessions =
    new Map();


function createSession(
    supplierId
) {

    const token =
        crypto
            .randomBytes(32)
            .toString("hex");


    sessions.set(

        token,

        {
            supplierId:
                supplierId,

            createdAt:
                Date.now()
        }
    );


    return token;
}


function getSessionToken(
    req
) {

    const cookieHeader =
        req.headers.cookie;


    if (!cookieHeader) {
        return null;
    }


    const cookies =
        cookieHeader
            .split(";")
            .map(
                function(cookie) {
                    return cookie.trim();
                }
            );


    const sessionCookie =
        cookies.find(
            function(cookie) {

                return cookie.startsWith(
                    "yadhuvii_supplier_session="
                );
            }
        );


    if (!sessionCookie) {
        return null;
    }


    return sessionCookie.split("=")[1];
}


function getLoggedInSupplier(
    req
) {

    const token =
        getSessionToken(req);


    if (!token) {
        return null;
    }


    const session =
        sessions.get(token);


    if (!session) {
        return null;
    }


    const suppliers =
        getSuppliers();


    return suppliers.find(
        function(supplier) {

            return supplier.id ===
                session.supplierId;

        }
    ) || null;
}


// ========================================
// AUTHENTICATION MIDDLEWARE
// ========================================

function requireSupplierAuth(
    req,
    res,
    next
) {

    const supplier =
        getLoggedInSupplier(req);


    if (!supplier) {

        if (
            req.path ===
                "/supplier-dashboard.html" ||

            req.path ===
                "/api/supplier/me"
        ) {

            return res
                .status(401)
                .json({

                    success:
                        false,

                    error:
                        "Not authenticated"
                });
        }


        return res
            .status(401)
            .json({

                success:
                    false,

                error:
                    "Authentication required"
            });
    }


    req.supplier =
        supplier;


    next();
}


// ========================================
// SUPPLIER ROUTES
// ========================================

app.post(
    "/api/supplier/register",
    function(req, res) {

        try {

            const {
                name,
                email,
                password
            } = req.body;


            if (
                !name ||
                !email ||
                !password
            ) {

                return res
                    .status(400)
                    .json({

                        success:
                            false,

                        error:
                            "Name, email and password are required"
                    });
            }


            const suppliers =
                getSuppliers();


            const existing =
                suppliers.find(
                    function(supplier) {

                        return supplier.email
                            .toLowerCase() ===
                            email.toLowerCase();

                    }
                );


            if (existing) {

                return res
                    .status(400)
                    .json({

                        success:
                            false,

                        error:
                            "Supplier already exists"
                    });
            }


            const passwordData =
                hashPassword(
                    password
                );


            const supplier = {

                id:
                    crypto
                        .randomBytes(16)
                        .toString("hex"),

                name:
                    name,

                email:
                    email.toLowerCase(),

                passwordHash:
                    passwordData.hash,

                passwordSalt:
                    passwordData.salt,

                createdAt:
                    new Date().toISOString()
            };


            suppliers.push(
                supplier
            );


            saveSuppliers(
                suppliers
            );


            const token =
                createSession(
                    supplier.id
                );


            res.setHeader(
                "Set-Cookie",
                `yadhuvii_supplier_session=${token}; HttpOnly; Path=/; SameSite=Lax`
            );


            return res.json({

                success:
                    true,

                supplier: {

                    id:
                        supplier.id,

                    name:
                        supplier.name,

                    email:
                        supplier.email
                }
            });


        } catch (error) {

            console.error(
                "SUPPLIER REGISTER ERROR:",
                error
            );


            return res
                .status(500)
                .json({

                    success:
                        false,

                    error:
                        error.message
                });
        }
    }
);


app.post(
    "/api/supplier/login",
    function(req, res) {

        try {

            const {
                email,
                password
            } = req.body;


            const suppliers =
                getSuppliers();


            const supplier =
                suppliers.find(
                    function(item) {

                        return item.email
                            .toLowerCase() ===
                            String(email || "")
                                .toLowerCase();

                    }
                );


            if (!supplier) {

                return res
                    .status(401)
                    .json({

                        success:
                            false,

                        error:
                            "Invalid email or password"
                    });
            }


            const valid =
                verifyPassword(
                    password,
                    supplier.passwordHash,
                    supplier.passwordSalt
                );


            if (!valid) {

                return res
                    .status(401)
                    .json({

                        success:
                            false,

                        error:
                            "Invalid email or password"
                    });
            }


            const token =
                createSession(
                    supplier.id
                );


            res.setHeader(
                "Set-Cookie",
                `yadhuvii_supplier_session=${token}; HttpOnly; Path=/; SameSite=Lax`
            );


            return res.json({

                success:
                    true,

                supplier: {

                    id:
                        supplier.id,

                    name:
                        supplier.name,

                    email:
                        supplier.email
                }
            });


        } catch (error) {

            console.error(
                "SUPPLIER LOGIN ERROR:",
                error
            );


            return res
                .status(500)
                .json({

                    success:
                        false,

                    error:
                        error.message
                });
        }
    }
);


app.get(
    "/api/supplier/me",
    function(req, res) {

        const supplier =
            getLoggedInSupplier(req);


        if (!supplier) {

            return res
                .status(401)
                .json({

                    success:
                        false,

                    error:
                        "Not authenticated"
                });
        }


        return res.json({

            success:
                true,

            supplier: {

                id:
                    supplier.id,

                name:
                    supplier.name,

                email:
                    supplier.email
            }
        });
    }
);


app.post(
    "/api/supplier/logout",
    function(req, res) {

        const token =
            getSessionToken(req);


        if (token) {
            sessions.delete(token);
        }


        res.setHeader(
            "Set-Cookie",
            "yadhuvii_supplier_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax"
        );


        return res.json({

            success:
                true
        });
    }
);


// ========================================
// PRINTIFY PRODUCTS
// ========================================

async function getPrintifyProducts(
    req,
    res
) {

    try {

        const token =
            process.env.PRINTIFY_API_TOKEN;


        if (!token) {

            return res
                .status(500)
                .json({

                    success:
                        false,

                    error:
                        "PRINTIFY_API_TOKEN is missing from .env"
                });
        }


        console.log(
            "================================"
        );

        console.log(
            "GETTING PRINTIFY PRODUCTS"
        );

        console.log(
            "================================"
        );


        const url =
            "https://api.printify.com/v1/shops/" +
            SHOP_ID +
            "/products.json";


        console.log(
            "Printify URL:",
            url
        );


        const response =
            await fetch(

                url,

                {

                    method:
                        "GET",

                    headers: {

                        "Authorization":
                            "Bearer " + token,

                        "Content-Type":
                            "application/json"
                    }
                }
            );


        const text =
            await response.text();


        console.log(
            "Printify response status:",
            response.status
        );


        let data;


        try {

            data =
                JSON.parse(
                    text
                );

        } catch (error) {

            console.error(
                "Could not parse Printify response"
            );


            return res
                .status(500)
                .json({

                    success:
                        false,

                    error:
                        "Invalid response from Printify",

                    response:
                        text
                });
        }


        if (!response.ok) {

            console.error(
                "Printify returned an error:"
            );


            console.error(
                data
            );


            return res
                .status(
                    response.status
                )
                .json({

                    success:
                        false,

                    printify_status:
                        response.status,

                    printify_response:
                        data
                });
        }


        console.log(
            "Products loaded successfully."
        );


        return res.json({

            success:
                true,

            shop_id:
                SHOP_ID,

            products:
                data
        });


    } catch (error) {

        console.error(
            "PRODUCTS ERROR",
            error
        );


        return res
            .status(500)
            .json({

                success:
                    false,

                error:
                    error.message
            });
    }
}


// ========================================
// PRODUCT ROUTES
// ========================================

app.get(
    "/api/cj-products",
    getCJProducts
);


app.get(
    "/api/cj-product/:productId",
    getCJProduct
);


app.get(
    "/api/products",
    getPrintifyProducts
);


app.get(
    "/printify-products",
    getPrintifyProducts
);


// ========================================
// GET ONE PRINTIFY PRODUCT
// ========================================

app.get(
    "/product/:productId",
    async function(req, res) {

        try {

            const token =
                process.env.PRINTIFY_API_TOKEN;


            const productId =
                req.params.productId;


            if (!token) {

                return res
                    .status(500)
                    .json({

                        success:
                            false,

                        error:
                            "PRINTIFY_API_TOKEN is missing from .env"
                    });
            }


            console.log(
                "Getting product:",
                productId
            );


            const response =
                await fetch(

                    "https://api.printify.com/v1/shops/" +
                    SHOP_ID +
                    "/products/" +
                    productId +
                    ".json",

                    {

                        method:
                            "GET",

                        headers: {

                            "Authorization":
                                "Bearer " + token,

                            "Content-Type":
                                "application/json"
                        }
                    }
                );


            const text =
                await response.text();


            let data;


            try {

                data =
                    JSON.parse(
                        text
                    );

            } catch (error) {

                return res
                    .status(500)
                    .json({

                        success:
                            false,

                        error:
                            "Invalid response from Printify",

                        response:
                            text
                    });
            }


            if (!response.ok) {

                return res
                    .status(
                        response.status
                    )
                    .json({

                        success:
                            false,

                        printify_status:
                            response.status,

                        printify_response:
                            data
                    });
            }


            const cleanProduct = {

                id:
                    data.id,

                title:
                    data.title,

                description:
                    data.description,

                images:
                    (data.images || [])
                        .map(
                            function(image) {

                                return {

                                    src:
                                        image.src,

                                    position:
                                        image.position
                                };
                            }
                        ),

                variants:
                    (data.variants || [])
                        .map(
                            function(variant) {

                                return {

                                    id:
                                        variant.id,

                                    title:
                                        variant.title,

                                    price:
                                        variant.price,

                                    available:
                                        variant.is_enabled,

                                    sku:
                                        variant.sku ||
                                        null
                                };
                            }
                        ),

                prices:
                    (data.variants || [])
                        .map(
                            function(variant) {

                                return {

                                    variant_id:
                                        variant.id,

                                    variant:
                                        variant.title,

                                    price:
                                        variant.price,

                                    currency:
                                        "USD"
                                };
                            }
                        ),

                availability:
                    (data.variants || [])
                        .map(
                            function(variant) {

                                return {

                                    variant_id:
                                        variant.id,

                                    variant:
                                        variant.title,

                                    available:
                                        variant.is_enabled
                                };
                            }
                        )
            };


            return res.json({

                success:
                    true,

                shop_id:
                    SHOP_ID,

                product:
                    cleanProduct
            });


        } catch (error) {

            console.error(
                "PRODUCT ERROR:",
                error
            );


            return res
                .status(500)
                .json({

                    success:
                        false,

                    error:
                        error.message
                });
        }
    }
);


// ========================================
// STATIC WEBSITE
// ========================================

app.use(
    express.static(
        __dirname
    )
);


// ========================================
// 404 HANDLER
// ========================================

app.use(
    function(req, res) {

        res
            .status(404)
            .json({

                success:
                    false,

                error:
                    "Route not found",

                requested_url:
                    req.originalUrl
            });
    }
);


// ========================================
// START SERVER
// ========================================

app.listen(
    PORT,
    function() {

        console.log("");
        console.log(
            "========================================"
        );

        console.log(
            "          GLOBIRA SERVER"
        );

        console.log(
            "========================================"
        );

        console.log(
            "Server: http://localhost:" +
            PORT
        );

        console.log("");

        console.log(
            "Website:"
        );

        console.log(
            "http://localhost:" +
            PORT
        );

        console.log("");

        console.log(
            "CJ Products:"
        );

        console.log(
            "http://localhost:" +
            PORT +
            "/api/cj-products?keyword=hoodie&size=1"
        );

        console.log("");

        console.log(
            "Printify Products:"
        );

        console.log(
            "http://localhost:" +
            PORT +
            "/api/products"
        );

        console.log("");

        console.log(
            "Shop ID:",
            SHOP_ID
        );

        console.log(
            "========================================"
        );

        console.log("");
    }
);
