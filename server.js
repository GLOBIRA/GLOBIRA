const express = require("express");
const path = require("path");

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;

const CJ_API_BASE =
    "https://developers.cjdropshipping.com/api2.0/v1";

let cjAccessToken = null;
let cjRefreshToken = null;
let cjTokenExpiresAt = 0;

let cjRequestChain = Promise.resolve();
let lastCJRequestAt = 0;


/* =========================================================
   HELPERS
   ========================================================= */

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}


/* =========================================================
   CJ AUTHENTICATION
   ========================================================= */

async function getCJAccessToken() {

    if (
        cjAccessToken &&
        Date.now() < cjTokenExpiresAt - 60 * 1000
    ) {
        return cjAccessToken;
    }

    const apiKey =
        String(process.env.CJ_API_KEY || "").trim();

    if (!apiKey) {
        throw new Error(
            "CJ API key is missing. Add CJ_API_KEY to Vercel Environment Variables."
        );
    }

    /*
     * Try the refresh token first when available.
     */
    if (cjRefreshToken) {

        try {

            const response = await fetch(
                `${CJ_API_BASE}/authentication/refreshAccessToken`,
                {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "Accept": "application/json"
                    },
                    body: JSON.stringify({
                        refreshToken: cjRefreshToken
                    })
                }
            );

            const text = await response.text();

            let json;

            try {
                json = JSON.parse(text);
            } catch {
                json = {};
            }

            const token =
                json?.data?.accessToken ||
                json?.data?.access_token ||
                json?.accessToken;

            if (response.ok && token) {

                cjAccessToken = token;

                cjRefreshToken =
                    json?.data?.refreshToken ||
                    json?.data?.refresh_token ||
                    cjRefreshToken;

                const expiry =
                    json?.data?.accessTokenExpiryDate ||
                    json?.data?.access_token_expiry_date;

                if (expiry) {
                    const expiryTime =
                        new Date(expiry).getTime();

                    if (Number.isFinite(expiryTime)) {
                        cjTokenExpiresAt = expiryTime;
                    }
                }

                if (
                    !cjTokenExpiresAt ||
                    cjTokenExpiresAt <= Date.now()
                ) {
                    cjTokenExpiresAt =
                        Date.now() +
                        14 * 24 * 60 * 60 * 1000;
                }

                console.log(
                    "GLOBIRA: CJ access token refreshed."
                );

                return cjAccessToken;
            }

        } catch (error) {

            console.warn(
                "GLOBIRA: CJ refresh failed. Requesting a new token.",
                error.message
            );
        }
    }


    /*
     * CURRENT CJ API-KEY AUTHENTICATION
     *
     * The existing CJ_API_KEY is sent as:
     *
     * {
     *     apiKey: "..."
     * }
     */
    console.log(
        "GLOBIRA: Requesting new CJ access token..."
    );

    const response = await fetch(
        `${CJ_API_BASE}/authentication/getAccessToken`,
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Accept": "application/json"
            },
            body: JSON.stringify({
                apiKey: apiKey
            })
        }
    );

    const text = await response.text();

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

    if (
        json?.code &&
        String(json.code) !== "200"
    ) {
        throw new Error(
            json.message ||
            json.msg ||
            `CJ authentication error: ${json.code}`
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

    cjRefreshToken =
        json?.data?.refreshToken ||
        json?.data?.refresh_token ||
        null;

    const expiry =
        json?.data?.accessTokenExpiryDate ||
        json?.data?.access_token_expiry_date;

    if (expiry) {

        const expiryTime =
            new Date(expiry).getTime();

        if (Number.isFinite(expiryTime)) {
            cjTokenExpiresAt = expiryTime;
        }
    }

    if (
        !cjTokenExpiresAt ||
        cjTokenExpiresAt <= Date.now()
    ) {

        const expiresIn =
            Number(
                json?.data?.expiresIn ||
                json?.data?.expires_in ||
                14 * 24 * 60 * 60
            );

        cjTokenExpiresAt =
            Date.now() +
            expiresIn * 1000;
    }

    console.log(
        "GLOBIRA: CJ access token obtained."
    );

    return cjAccessToken;
}


/* =========================================================
   CJ GET REQUEST
   ========================================================= */

async function cjGet(url) {

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

            const elapsed =
                Date.now() - lastCJRequestAt;

            if (elapsed < 1100) {
                await sleep(1100 - elapsed);
            }

            lastCJRequestAt =
                Date.now();

            const response =
                await fetch(
                    url,
                    {
                        method: "GET",
                        headers: {
                            "CJ-Access-Token": token,
                            "Content-Type": "application/json",
                            "Accept": "application/json"
                        }
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

            const code =
                String(json?.code ?? "");

            const message =
                String(
                    json?.message ||
                    json?.msg ||
                    ""
                );


            /*
             * TOKEN EXPIRED
             */

            if (
                response.status === 401 ||
                code === "401" ||
                code === "1600001"
            ) {

                cjAccessToken = null;
                cjTokenExpiresAt = 0;

                if (attempt < maxRetries) {

                    console.log(
                        "GLOBIRA: CJ token expired. Retrying authentication..."
                    );

                    await sleep(700);

                    continue;
                }
            }


            /*
             * RATE LIMIT
             */

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

                if (attempt < maxRetries) {

                    await sleep(waitTime);

                    continue;
                }
            }


            /*
             * HTTP ERROR
             */

            if (!response.ok) {

                throw new Error(
                    json?.message ||
                    json?.msg ||
                    `CJ API request failed: ${response.status}`
                );
            }


            /*
             * CJ APPLICATION ERROR
             */

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
                (value, index, array) =>
                    array.indexOf(value) === index
            );

    const rawPrice =
        Number(
            source.sellPrice ||
            source.price ||
            source.productPrice ||
            source.minPrice ||
            0
        ) || 0;

    const productId =
        source.pid ||
        source.id ||
        "";

    return {

        id:
            productId
                ? "cj-" + productId
                : "cj-" + Date.now(),

        cjProductId:
            productId,

        sku:
            source.productSku ||
            source.sku ||
            "",

        name:
            source.productNameEn ||
            source.nameEn ||
            source.productName ||
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
   CJ PRODUCT LIST
   ========================================================= */

async function getCJProducts(req, res) {

    try {

        const keyword =
            String(
                req.query.keyword || ""
            ).trim();

        const page =
            Math.max(
                Number(
                    req.query.page
                ) || 1,
                1
            );

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

        const content =
            Array.isArray(
                data.content
            )
                ? data.content
                : [];

        const nestedProducts =
            content.flatMap(
                item =>
                    Array.isArray(
                        item?.productList
                    )
                        ? item.productList
                        : []
            );

        const directProducts =
            content.filter(
                item =>
                    item &&
                    !Array.isArray(
                        item?.productList
                    ) &&
                    (
                        item.pid ||
                        item.id ||
                        item.productNameEn ||
                        item.nameEn
                    )
            );

        const products =
            nestedProducts.length
                ? nestedProducts
                : directProducts;

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
                data.totalRecords || 0
            );

        const totalPages =
            Number(
                data.totalPages || 0
            );

        const currentPage =
            Number(
                data.pageNumber || page
            );

        res.json({

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
                totalPages
                    ? currentPage < totalPages
                    : normalized.length === size,

            products:
                normalized
        });

    } catch (error) {

        console.error(
            "GLOBIRA CJ PRODUCTS ERROR:",
            error
        );

        res.status(500).json({

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
   SINGLE CJ PRODUCT
   ========================================================= */

async function getCJProduct(req, res) {

    try {

        const productId =
            String(
                req.params.productId || ""
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

        res.json({

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

        res.status(500).json({

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
   STATIC WEBSITE
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
   LOCAL SERVER
   ========================================================= */

if (
    require.main === module
) {

    app.listen(
        PORT,
        () => {

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
                `Local server: http://localhost:${PORT}`
            );

            console.log(
                `CJ API: http://localhost:${PORT}/api/cj-products?page=1&size=1`
            );

            console.log(
                "========================================"
            );
            console.log("");
        }
    );
}


/* =========================================================
   VERCEL EXPORT
   ========================================================= */

module.exports = app;
