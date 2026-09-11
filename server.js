const express = require("express");
const path = require("path");

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;

const CJ_API_BASE =
    "https://developers.cjdropshipping.com/api2.0/v1";

let cjAccessToken = null;
let cjTokenExpiresAt = 0;


/* =========================================================
   CJ DROPSHIPPING AUTHENTICATION
   ========================================================= */

async function getCJAccessToken() {

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
            "CJ API key is missing. Add CJ_API_KEY to your environment variables."
        );
    }

    /*
     * If a ready CJ access token is supplied,
     * use it directly.
     */
    if (!apiSecret) {
        cjAccessToken = apiKey;
        cjTokenExpiresAt =
            Date.now() + 50 * 60 * 1000;

        return cjAccessToken;
    }

    const response = await fetch(
        `${CJ_API_BASE}/authentication/getAccessToken`,
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                email: apiKey,
                password: apiSecret
            })
        }
    );

    if (!response.ok) {
        throw new Error(
            `CJ authentication failed: ${response.status}`
        );
    }

    const json = await response.json();

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
                    "CJ-Access-Token": token,
                    "Content-Type": "application/json"
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


    return {

        id:
            "cj-" +
            (
                source.pid ||
                source.id ||
                Date.now()
            ),

        cjProductId:
            source.pid ||
            source.id ||
            "",

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


        const content =
            Array.isArray(
                data.content
            )
                ? data.content
                : [];


        const products =
            content.flatMap(
                item =>
                    item?.productList || []
            );


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
                error.message
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
   FRONTEND
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

if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`
========================================
          GLOBIRA SERVER
========================================
Server: http://localhost:${PORT}
Website:
http://localhost:${PORT}
CJ Products:
http://localhost:${PORT}/api/cj-products?keyword=hoodie&size=1
Printify Products:
http://localhost:${PORT}/api/products
CJ API:
${CJ_API_BASE}
========================================
        `);
    });
}

module.exports = app;
