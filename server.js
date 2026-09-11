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


/* =========================================================
   CJ DROPSHIPPING AUTHENTICATION
   ========================================================= */

async function getCJAccessToken() {

    // Reuse existing access token while it is still valid.
    if (
        cjAccessToken &&
        Date.now() < cjTokenExpiresAt - 60 * 1000
    ) {
        return cjAccessToken;
    }

    const apiKey =
        String(
            process.env.CJ_API_KEY || ""
        ).trim();

    if (!apiKey) {
        throw new Error(
            "CJ API key is missing. Add CJ_API_KEY to your environment variables."
        );
    }

    /*
     * If we already have a refresh token, try refreshing first.
     */
    if (cjRefreshToken) {

        try {

            const refreshResponse =
                await fetch(
                    `${CJ_API_BASE}/authentication/refreshAccessToken`,
                    {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json"
                        },
                        body: JSON.stringify({
                            refreshToken:
                                cjRefreshToken
                        })
                    }
                );

            const refreshText =
                await refreshResponse.text();

            let refreshJson;

            try {
                refreshJson =
                    JSON.parse(refreshText);
            } catch {
                refreshJson = {};
            }

            const refreshedToken =
                refreshJson?.data?.accessToken ||
                refreshJson?.data?.access_token ||
                refreshJson?.accessToken;

            if (
                refreshResponse.ok &&
                refreshedToken
            ) {

                cjAccessToken =
                    refreshedToken;

                cjRefreshToken =
                    refreshJson?.data?.refreshToken ||
                    refreshJson?.data?.refresh_token ||
                    cjRefreshToken;

                const expiryDate =
                    refreshJson?.data?.accessTokenExpiryDate ||
                    refreshJson?.data?.access_token_expiry_date;

                if (expiryDate) {

                    const expiryTime =
                        new Date(
                            expiryDate
                        ).getTime();

                    if (
                        Number.isFinite(
                            expiryTime
                        )
                    ) {
                        cjTokenExpiresAt =
                            expiryTime;
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
                    "CJ access token refreshed successfully."
                );

                return cjAccessToken;
            }

        } catch (error) {

            console.warn(
                "CJ refresh token request failed. Requesting a new access token.",
                error.message
            );
        }
    }


    /*
     * IMPORTANT:
     *
     * CJ's current API-key authentication endpoint expects:
     *
     * {
     *     "apiKey": "CJUserNum@api@..."
     * }
     *
     * It does NOT use the old email/password format.
     */
    console.log(
        "Requesting new CJ access token..."
    );

    const response =
        await fetch(
            `${CJ_API_BASE}/authentication/getAccessToken`,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    apiKey: apiKey
                })
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


    if (!response.ok) {

        throw new Error(
            json?.message ||
            json?.msg ||
            `CJ authentication failed: ${response.status}`
        );
    }


    if (
        json &&
        json.code &&
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


    cjAccessToken =
        token;


    cjRefreshToken =
        json?.data?.refreshToken ||
        json?.data?.refresh_token ||
        null;


    /*
     * CJ returns the actual access-token expiry date.
     * Prefer that over guessing a fixed lifetime.
     */
    const expiryDate =
        json?.data?.accessTokenExpiryDate ||
        json?.data?.access_token_expiry_date;


    if (expiryDate) {

        const expiryTime =
            new Date(
                expiryDate
            ).getTime();

        if (
            Number.isFinite(
                expiryTime
            )
        ) {

            cjTokenExpiresAt =
                expiryTime;
        }
    }


    /*
     * Fallback only if CJ did not return an expiry date.
     */
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
        "CJ access token obtained successfully."
    );


    return cjAccessToken;
}


/* =========================================================
   CJ API REQUEST HELPER
   ========================================================= */

async function cjGet(url) {

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

                    "Content-Type":
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


    if (!response.ok) {

        throw new Error(
            json?.message ||
            json?.msg ||
            `CJ API request failed: ${response.status}`
        );
    }


    if (
        json &&
        json.code &&
        String(json.code) !== "200"
    ) {

        throw new Error(
            json.message ||
            json.msg ||
            `CJ API error: ${json.code}`
        );
    }


    return json;
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


    const images = [

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

    ]
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
            product?.productNameEn ||
            product?.nameEn ||
            source.productName ||
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
   GET CJ PRODUCTS
   ========================================================= */

async function getCJProducts(
    req,
    res
) {

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


        /*
         * Ask CJ for description and category
         * information when available.
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
            "Loading CJ products:",
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
         * CJ listV2 normally returns:
         *
         * data.content[]
         *   -> productList[]
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
         * Some CJ responses may return product
         * objects directly inside content.
         */
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


        const combinedProducts =
            products.length
                ? products
                : directProducts;


        const normalized =
            combinedProducts
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
            "CJ PRODUCTS ERROR:",
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
   GET ONE CJ PRODUCT
   ========================================================= */

async function getCJProduct(
    req,
    res
) {

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
            "Loading CJ product:",
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
            "CJ PRODUCT ERROR:",
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
            "SERVER ERROR:",
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

/*
 * IMPORTANT FOR VERCEL:
 *
 * Only start a local HTTP server when this file
 * is executed directly with:
 *
 *     node server.js
 *
 * Vercel imports this file as a module/function,
 * so app.listen() must not run during import.
 */

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
                `Server: http://localhost:${PORT}`
            );

            console.log("");

            console.log(
                "Website:"
            );

            console.log(
                `http://localhost:${PORT}`
            );

            console.log("");

            console.log(
                "CJ Products:"
            );

            console.log(
                `http://localhost:${PORT}/api/cj-products?page=1&size=1`
            );

            console.log("");

            console.log(
                "CJ API:"
            );

            console.log(
                CJ_API_BASE
            );

            console.log(
                "========================================"
            );
        }
    );
}


/* =========================================================
   EXPORT FOR VERCEL
   ========================================================= */

module.exports = app;
