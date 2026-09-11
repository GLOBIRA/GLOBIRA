const express = require("express");
const path = require("path");

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;

const CJ_API_BASE =
    "https://developers.cjdropshipping.com/api2.0/v1";


/* =========================================================
   CJ AUTHENTICATION STATE
   ========================================================= */

let cjAccessToken = null;
let cjTokenExpiresAt = 0;


/* =========================================================
   CJ REQUEST QUEUE / RATE LIMIT PROTECTION
   ========================================================= */

let cjRequestChain = Promise.resolve();
let lastCJRequestAt = 0;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}


/* =========================================================
   CJ DROPSHIPPING AUTHENTICATION
   ========================================================= */

async function getCJAccessToken() {

    /*
     * Reuse a valid token.
     */
    if (
        cjAccessToken &&
        Date.now() < cjTokenExpiresAt - 60 * 1000
    ) {
        return cjAccessToken;
    }

    const apiKey =
        process.env.CJ_API_KEY ||
        process.env.CJ_ACCESS_TOKEN;

    const apiSecret =
        process.env.CJ_API_SECRET;

    if (!apiKey) {
        throw new Error(
            "CJ API key is missing. Add CJ_API_KEY to Vercel Environment Variables."
        );
    }

    /*
     * GLOBIRA currently supports using CJ_API_KEY
     * directly as the ready CJ access token.
     */
    if (!apiSecret) {

        cjAccessToken = apiKey;

        cjTokenExpiresAt =
            Date.now() + 50 * 60 * 1000;

        return cjAccessToken;
    }

    /*
     * If email/password authentication is configured,
     * obtain a fresh CJ access token.
     */
    const response = await fetch(
        `${CJ_API_BASE}/authentication/getAccessToken`,
        {
            method: "POST",

            headers: {
                "Content-Type": "application/json",
                "Accept": "application/json"
            },

            body: JSON.stringify({
                email: apiKey,
                password: apiSecret
            })
        }
    );

    const text =
        await response.text();

    let json;

    try {
        json = JSON.parse(text);
    } catch {
        json = {
            message: text
        };
    }

    if (!response.ok) {

        throw new Error(
            json?.message ||
            json?.msg ||
            `CJ authentication failed: ${response.status}`
        );
    }

    const token =
        json?.data?.accessToken ||
        json?.data?.access_token ||
        json?.accessToken;

    if (!token) {

        throw new Error(
            "CJ authentication succeeded but no access token was returned."
        );
    }

    cjAccessToken = token;

    cjTokenExpiresAt =
        Date.now() +
        Number(
            json?.data?.expiresIn || 3600
        ) * 1000;

    return cjAccessToken;
}


/* =========================================================
   CJ API GET HELPER
   ========================================================= */

async function cjGet(url) {

    /*
     * Queue all CJ requests.
     *
     * This prevents several browser requests from
     * hitting CJ at exactly the same time.
     */
    const previousRequest =
        cjRequestChain;

    let release;

    cjRequestChain =
        new Promise(resolve => {
            release = resolve;
        });

    await previousRequest;

    try {

        const maxRetries = 5;

        for (
            let attempt = 1;
            attempt <= maxRetries;
            attempt++
        ) {

            const token =
                await getCJAccessToken();

            /*
             * Keep CJ requests approximately
             * 1.1 seconds apart.
             */
            const elapsed =
                Date.now() - lastCJRequestAt;

            if (elapsed < 1100) {

                await sleep(
                    1100 - elapsed
                );
            }

            lastCJRequestAt =
                Date.now();

            const response =
                await fetch(
                    url,
                    {
                        method: "GET",

                        headers: {
                            "CJ-Access-Token":
                                token,

                            "Content-Type":
                                "application/json",

                            "Accept":
                                "application/json"
                        }
                    }
                );

            const text =
                await response.text();

            let json;

            try {

                json =
                    JSON.parse(text);

            } catch {

                json = {
                    message: text
                };
            }

            const code =
                String(
                    json?.code ?? ""
                );

            const message =
                String(
                    json?.message ||
                    json?.msg ||
                    ""
                );


            /* -------------------------------------------------
               TOKEN EXPIRED
               ------------------------------------------------- */

            if (
                response.status === 401 ||
                code === "401"
            ) {

                cjAccessToken = null;
                cjTokenExpiresAt = 0;

                if (
                    attempt < maxRetries
                ) {

                    console.log(
                        "GLOBIRA: CJ access token expired. Refreshing..."
                    );

                    await sleep(700);

                    continue;
                }
            }


            /* -------------------------------------------------
               RATE LIMIT
               ------------------------------------------------- */

            const isRateLimited =
                response.status === 429 ||
                code === "429" ||
                /too many requests|qps limit|rate limit/i.test(
                    message
                );

            if (isRateLimited) {

                const waitTime =
                    2000 +
                    attempt * 1500;

                console.log(
                    `GLOBIRA: CJ rate limit. Retry ${attempt}/${maxRetries} in ${waitTime}ms`
                );

                if (
                    attempt < maxRetries
                ) {

                    await sleep(
                        waitTime
                    );

                    continue;
                }
            }


            /* -------------------------------------------------
               HTTP ERROR
               ------------------------------------------------- */

            if (!response.ok) {

                throw new Error(
                    json?.message ||
                    json?.msg ||
                    `CJ API request failed: ${response.status}`
                );
            }


            /* -------------------------------------------------
               CJ APPLICATION ERROR
               ------------------------------------------------- */

            if (
                json &&
                json.code &&
                code !== "200"
            ) {

                throw new Error(
                    json.message ||
                    json.msg ||
                    `CJ API error: ${json.code}`
                );
            }


            return json;
        }


        throw new Error(
            "CJ API request failed after multiple retries."
        );

    } finally {

        release();
    }
}


/* =========================================================
   NORMALIZE CJ PRODUCT
   ========================================================= */

function normalizeCJProduct(
    product,
    details = null
) {

    const source =
        details ||
        product ||
        {};


    /* -------------------------------------------------------
       IMAGES
       ------------------------------------------------------- */

    const rawImages = [

        ...(Array.isArray(
            source.productImage
        )
            ? source.productImage
            : []),

        ...(Array.isArray(
            source.images
        )
            ? source.images
            : []),

        source.productImageUrl,

        source.image,

        source.mainImage

    ];


    const images =
        rawImages
            .filter(Boolean)
            .map(String)
            .filter(
                (
                    value,
                    index,
                    array
                ) =>
                    array.indexOf(
                        value
                    ) === index
            );


    /* -------------------------------------------------------
       PRICE
       ------------------------------------------------------- */

    const rawPrice =
        Number(
            source.sellPrice ||
            source.price ||
            source.productPrice ||
            source.minPrice ||
            0
        ) || 0;


    /* -------------------------------------------------------
       PRODUCT
       ------------------------------------------------------- */

    const productId =
        source.pid ||
        source.id ||
        product?.pid ||
        product?.id ||
        "";


    return {

        id:
            "cj-" +
            (
                productId ||
                Date.now()
            ),

        cjProductId:
            productId,

        sku:
            source.productSku ||
            source.sku ||
            product?.productSku ||
            product?.sku ||
            "",

        name:
            source.productNameEn ||
            source.nameEn ||
            source.productName ||
            product?.productNameEn ||
            product?.nameEn ||
            product?.productName ||
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

        price:
            rawPrice,

        oldPrice:
            rawPrice,

        category:
            source.categoryNameEn ||
            source.categoryName ||
            product?.categoryNameEn ||
            product?.categoryName ||
            "",

        subcategory:
            source.subCategoryNameEn ||
            source.subcategoryNameEn ||
            source.subCategoryName ||
            product?.subCategoryNameEn ||
            product?.subcategoryNameEn ||
            "",

        gender:
            source.gender ||
            product?.gender ||
            "",

        variants:
            Array.isArray(
                source.variants
            )
                ? source.variants
                : [],

        source:
            "cjdropshipping"
    };
}


/* =========================================================
   GET CJ PRODUCT LIST
   ========================================================= */

async function getCJProducts(
    req,
    res
) {

    try {

        const keyword =
            String(
                req.query.keyword ||
                req.query.keyWord ||
                ""
            ).trim();


        const page =
            Math.max(
                Number(
                    req.query.page
                ) || 1,
                1
            );


        /*
         * Maximum 100 products per CJ request.
         */
        const size =
            Math.min(
                Math.max(
                    Number(
                        req.query.size
                    ) || 100,
                    1
                ),
                100
            );


        const listUrl =
            new URL(
                `${CJ_API_BASE}/product/listV2`
            );


        listUrl.searchParams.set(
            "page",
            String(page)
        );


        listUrl.searchParams.set(
            "size",
            String(size)
        );


        if (keyword) {

            listUrl.searchParams.set(
                "keyWord",
                keyword
            );
        }


        /*
         * Request descriptions and categories
         * so GLOBIRA can classify products.
         */
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
            "GLOBIRA: Loading CJ products:",
            keyword || "ALL",
            "page:",
            page,
            "size:",
            size
        );


        const listJson =
            await cjGet(
                listUrl.toString()
            );


        const data =
            listJson?.data || {};


        /*
         * Standard CJ listV2 response.
         */
        const content =
            Array.isArray(
                data.content
            )
                ? data.content
                : [];


        const products =
            content.flatMap(
                item =>
                    Array.isArray(
                        item?.productList
                    )
                        ? item.productList
                        : []
            );


        /*
         * Compatibility with alternative
         * CJ response structures.
         */
        if (
            products.length === 0 &&
            Array.isArray(
                data.productList
            )
        ) {

            products.push(
                ...data.productList
            );
        }


        if (
            products.length === 0 &&
            Array.isArray(
                data.products
            )
        ) {

            products.push(
                ...data.products
            );
        }


        const normalized =
            products
                .slice(0, size)
                .map(
                    product =>
                        normalizeCJProduct(
                            product
                        )
                );


        const totalRecords =
            Number(
                data.totalRecords ||
                data.total ||
                0
            );


        const totalPages =
            Number(
                data.totalPages ||
                0
            );


        const currentPage =
            Number(
                data.pageNumber ||
                data.page ||
                page
            );


        const hasMore =
            totalPages
                ? currentPage <
                  totalPages
                : normalized.length ===
                  size;


        console.log(
            "GLOBIRA: CJ products returned:",
            normalized.length,
            "page:",
            currentPage
        );


        return res.json({

            success:
                true,

            source:
                "cjdropshipping",

            keyword:
                keyword,

            page:
                currentPage,

            size:
                size,

            totalRecords:
                totalRecords,

            totalPages:
                totalPages,

            hasMore:
                hasMore,

            products:
                normalized
        });


    } catch (error) {

        console.error(
            "GLOBIRA CJ PRODUCTS ERROR:",
            error
        );


        return res.status(500).json({

            success:
                false,

            source:
                "cjdropshipping",

            error:
                error.message ||
                "Unable to load CJ products."
        });
    }
}


/* =========================================================
   GET ONE CJ PRODUCT
   ========================================================= */

async function getCJProduct(
    req,
    res
) {

    try {

        const productId =
            String(
                req.params.productId ||
                ""
            ).trim();


        if (!productId) {

            return res.status(400).json({

                success:
                    false,

                error:
                    "Product ID is required."
            });
        }


        const url =
            `${CJ_API_BASE}/product/query?pid=${encodeURIComponent(productId)}`;


        console.log(
            "GLOBIRA: Loading CJ product:",
            productId
        );


        const json =
            await cjGet(url);


        const product =
            json?.data || {};


        const normalized =
            normalizeCJProduct(
                product,
                product
            );


        return res.json({

            success:
                true,

            source:
                "cjdropshipping",

            product:
                normalized
        });


    } catch (error) {

        console.error(
            "GLOBIRA CJ PRODUCT ERROR:",
            error
        );


        return res.status(500).json({

            success:
                false,

            source:
                "cjdropshipping",

            error:
                error.message ||
                "Unable to load CJ product."
        });
    }
}


/* =========================================================
   API ROUTES
   ========================================================= */

app.get(
    "/api/cj-products",
    getCJProducts
);


app.get(
    "/api/cj-product/:productId",
    getCJProduct
);


/* =========================================================
   FRONTEND STATIC FILES
   ========================================================= */

app.use(
    express.static(
        path.join(__dirname)
    )
);


/* =========================================================
   HOME PAGE
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


/* =========================================================
   ERROR HANDLER
   ========================================================= */

app.use(
    (err, req, res, next) => {

        console.error(
            "GLOBIRA SERVER ERROR:",
            err
        );


        res.status(500).json({

            success:
                false,

            error:
                err.message ||
                "Internal server error."
        });
    }
);


/* =========================================================
   START SERVER
   ========================================================= */

if (
    require.main === module
) {

    app.listen(
        PORT,
        () => {

            console.log(`
========================================
          GLOBIRA SERVER
========================================

Server:
http://localhost:${PORT}

Website:
http://localhost:${PORT}

CJ Products:
http://localhost:${PORT}/api/cj-products?size=1

CJ Product:
http://localhost:${PORT}/api/cj-product/PRODUCT_ID

CJ API:
${CJ_API_BASE}

========================================
            `);
        }
    );
}


/* =========================================================
   VERCEL EXPORT
   ========================================================= */

module.exports = app;