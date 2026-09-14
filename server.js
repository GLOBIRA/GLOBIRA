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

    const apiKey = process.env.CJ_API_KEY;

    if (!apiKey) {
        throw new Error(
            "CJ API key is missing. Add CJ_API_KEY to your Vercel environment variables."
        );
    }

    const response = await fetch(
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
        json?.data?.access_token;

    if (!token) {
        throw new Error(
            "CJ authentication succeeded but no access token was returned."
        );
    }

    cjAccessToken = token;

    const expiryDate =
        json?.data?.accessTokenExpiryDate;

    if (expiryDate) {

        const expiryMs =
            Date.parse(expiryDate);

        cjTokenExpiresAt =
            Number.isFinite(expiryMs)
                ? expiryMs
                : Date.now() + 50 * 60 * 1000;

    } else {

        cjTokenExpiresAt =
            Date.now() + 50 * 60 * 1000;
    }

    return cjAccessToken;
}


/* =========================================================
   CJ GET REQUEST
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
   COLLECT CJ IMAGES
   ========================================================= */

function collectCJImages(
    value,
    output = []
) {

    if (value == null) {
        return output;
    }

    if (Array.isArray(value)) {

        for (const item of value) {

            collectCJImages(
                item,
                output
            );
        }

        return output;
    }

    if (typeof value === "object") {

        const preferredKeys = [

            "url",
            "imageUrl",
            "imageURL",
            "productImageUrl",
            "bigImage",
            "mainImage",
            "src"

        ];

        for (const key of preferredKeys) {

            if (value[key]) {

                collectCJImages(
                    value[key],
                    output
                );
            }
        }

        return output;
    }

    const text =
        String(value).trim();

    if (!text) {
        return output;
    }


    /* CJ sometimes returns JSON image arrays */

    if (
        (
            text.startsWith("[") &&
            text.endsWith("]")
        ) ||
        (
            text.startsWith("{") &&
            text.endsWith("}")
        )
    ) {

        try {

            const parsed =
                JSON.parse(text);

            collectCJImages(
                parsed,
                output
            );

            return output;

        } catch {
            /* Continue below */
        }
    }


    /* Comma-separated image URLs */

    if (
        text.includes(",") &&
        /https?:\/\//i.test(text)
    ) {

        for (
            const part of text.split(",")
        ) {

            const trimmed =
                part.trim();

            if (trimmed) {

                collectCJImages(
                    trimmed,
                    output
                );
            }
        }

        return output;
    }


    /* Protocol-relative URL */

    if (text.startsWith("//")) {

        output.push(
            "https:" + text
        );

        return output;
    }


    /* Normal URL */

    if (
        /^https?:\/\//i.test(text)
    ) {

        output.push(text);
    }

    return output;
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

    const getValue = (...values) => {

        for (const value of values) {

            if (
                value !== undefined &&
                value !== null &&
                String(value).trim() !== ""
            ) {

                return value;
            }
        }

        return "";
    };


    /* ---------------------------------------------------------
       IMAGES
       --------------------------------------------------------- */

    const imageValues = [

        source.bigImage,
        source.productImage,
        source.productImageSet,
        source.images,
        source.productImageUrl,
        source.image,
        source.mainImage,
        source.picUrl,
        source.imageUrl,
        source.imageURL,

        product?.bigImage,
        product?.productImage,
        product?.productImageSet,
        product?.images,
        product?.productImageUrl,
        product?.image,
        product?.mainImage,
        product?.picUrl,
        product?.imageUrl,
        product?.imageURL

    ];

    const images =
        Array.from(
            new Set(
                imageValues
                    .flatMap(
                        value =>
                            collectCJImages(
                                value,
                                []
                            )
                    )
                    .filter(Boolean)
            )
        );


    /* ---------------------------------------------------------
       PRICES
       --------------------------------------------------------- */

    const discountPrice =
        Number(
            getValue(
                source.discountPrice,
                source.nowPrice,
                product?.discountPrice,
                product?.nowPrice
            )
        ) || 0;

    const sellPrice =
        Number(
            getValue(
                source.sellPrice,
                product?.sellPrice
            )
        ) || 0;

    const normalPrice =
        Number(
            getValue(
                source.price,
                source.productPrice,
                source.minPrice,
                product?.price,
                product?.productPrice,
                product?.minPrice
            )
        ) || 0;

    const price =
        discountPrice ||
        sellPrice ||
        normalPrice ||
        0;

    const oldPrice =
        sellPrice > price
            ? sellPrice
            : normalPrice > price
                ? normalPrice
                : price;


    /* ---------------------------------------------------------
       PRODUCT ID
       --------------------------------------------------------- */

    const productId =
        getValue(

            source.pid,
            source.productId,
            source.id,

            product?.pid,
            product?.productId,
            product?.id

        );


    /* ---------------------------------------------------------
       PRODUCT NAME
       --------------------------------------------------------- */

    const name =
        getValue(

            source.productNameEn,
            source.nameEn,
            source.productName,
            source.name,

            product?.productNameEn,
            product?.nameEn,
            product?.productName,
            product?.name,

            "CJ Product"

        );


    /* ---------------------------------------------------------
       SKU
       --------------------------------------------------------- */

    const sku =
        getValue(

            source.productSku,
            source.sku,
            source.spu,

            product?.productSku,
            product?.sku,
            product?.spu

        );


    /* ---------------------------------------------------------
       CATEGORY
       --------------------------------------------------------- */

    const category =
        getValue(

            source.oneCategoryName,
            source.twoCategoryName,
            source.threeCategoryName,

            source.categoryNameEn,
            source.categoryName,
            source.category,

            product?.oneCategoryName,
            product?.twoCategoryName,
            product?.threeCategoryName,

            product?.categoryNameEn,
            product?.categoryName

        );


    /* ---------------------------------------------------------
       SUBCATEGORY
       --------------------------------------------------------- */

    const subcategory =
        getValue(

            source.threeCategoryName,
            source.subCategoryNameEn,
            source.subcategoryNameEn,
            source.subCategoryName,
            source.subcategoryName,

            product?.threeCategoryName,
            product?.subCategoryNameEn,
            product?.subcategoryNameEn,
            product?.subCategoryName,
            product?.subcategoryName

        );


    /* ---------------------------------------------------------
       FINAL PRODUCT
       --------------------------------------------------------- */

    return {

        id:
            "cj-" +
            (
                productId ||
                `unknown-${Date.now()}-${Math.random()
                    .toString(36)
                    .slice(2, 8)}`
            ),

        cjProductId:
            productId || "",

        sku,

        name,

        description:
            getValue(

                source.description,
                product?.description,

                "Authentic product sourced through CJdropshipping."

            ),

        images,

        price,

        oldPrice,

        category,

        subcategory,

        gender:
            getValue(
                source.gender,
                product?.gender
            ),

        variants:
            Array.isArray(
                source.variants
            )
                ? source.variants
                : Array.isArray(
                    product?.variants
                )
                    ? product.variants
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
                    ) || 20,
                    1
                ),
                100
            );


        /* ---------------------------------------------------------
           CJ PRODUCT LIST URL
           --------------------------------------------------------- */

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
         * CJ expects features as repeated parameters.
         */

        listUrl.searchParams.append(
            "features",
            "enable_description"
        );

        listUrl.searchParams.append(
            "features",
            "enable_category"
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
            "========================================"
        );

        console.log(
            "GLOBIRA: Loading CJ products"
        );

        console.log(
            "Keyword:",
            keyword || "ALL"
        );

        console.log(
            "Page:",
            page,
            "Size:",
            size
        );

        console.log(
            "========================================"
        );


        const listJson =
            await cjGet(
                listUrl.toString()
            );

        const data =
            listJson?.data || {};


        /* ---------------------------------------------------------
           READ CJ RESPONSE
           --------------------------------------------------------- */

        let products = [];


        if (
            Array.isArray(
                data.content
            )
        ) {

            products =
                data.content.flatMap(
                    item =>

                        Array.isArray(
                            item?.productList
                        )
                            ? item.productList
                            : []

                );
        }


        /*
         * Compatibility with other CJ response formats.
         */

        if (
            !products.length &&
            Array.isArray(
                data.productList
            )
        ) {

            products =
                data.productList;
        }


        if (
            !products.length &&
            Array.isArray(
                data.list
            )
        ) {

            products =
                data.list;
        }


        /* ---------------------------------------------------------
           NORMALIZE
           --------------------------------------------------------- */

        const normalized =
            products

                .map(
                    product =>
                        normalizeCJProduct(
                            product
                        )
                )

                .filter(
                    product =>
                        product &&
                        product.cjProductId &&
                        product.name
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


        const hasMore =
            totalPages > 0
                ? currentPage < totalPages
                : normalized.length >= size;


        console.log(
            `GLOBIRA: CJ returned ${normalized.length} products`
        );


        /* ---------------------------------------------------------
           RESPONSE
           --------------------------------------------------------- */

        res.json({

            success:
                true,

            source:
                "cjdropshipping",

            keyword,

            page:
                currentPage,

            size,

            totalRecords,

            totalPages,

            hasMore,

            products:
                normalized

        });


    } catch (error) {

        console.error(
            "========================================"
        );

        console.error(
            "GLOBIRA CJ PRODUCTS ERROR"
        );

        console.error(
            error?.message ||
            error
        );

        console.error(
            "========================================"
        );


        const message =
            error?.message ||
            "CJ Dropshipping API request failed.";


        const status =
            message.includes(
                "CJ API key is missing"
            )
                ? 503
                : 500;


        res.status(
            status
        ).json({

            success:
                false,

            source:
                "cjdropshipping",

            error:
                message

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

            return res.status(
                400
            ).json({

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
            await cjGet(
                url
            );


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
            error?.message ||
            error
        );


        res.status(
            500
        ).json({

            success:
                false,

            source:
                "cjdropshipping",

            error:
                error?.message ||
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


/* =========================================================
   CJ CONNECTION STATUS
   ========================================================= */

app.get(
    "/api/cj-status",
    async (req, res) => {

        const configured =
            Boolean(
                process.env.CJ_API_KEY
            );


        if (!configured) {

            return res.status(
                503
            ).json({

                success:
                    false,

                configured:
                    false,

                cjConnected:
                    false,

                productCount:
                    0,

                error:
                    "CJ_API_KEY is missing from the server environment."

            });
        }


        try {

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
                "1"
            );


            listUrl.searchParams.append(
                "features",
                "enable_description"
            );

            listUrl.searchParams.append(
                "features",
                "enable_category"
            );


            const json =
                await cjGet(
                    listUrl.toString()
                );


            const data =
                json?.data || {};


            let products = [];


            if (
                Array.isArray(
                    data.content
                )
            ) {

                products =
                    data.content.flatMap(
                        item =>

                            Array.isArray(
                                item?.productList
                            )
                                ? item.productList
                                : []

                    );
            }


            res.json({

                success:
                    true,

                configured:
                    true,

                cjConnected:
                    true,

                productCount:
                    products.length,

                totalRecords:
                    Number(
                        data.totalRecords || 0
                    ),

                message:
                    "CJ API connection is working."

            });


        } catch (error) {

            console.error(
                "CJ STATUS ERROR:",
                error?.message ||
                error
            );


            res.status(
                500
            ).json({

                success:
                    false,

                configured:
                    true,

                cjConnected:
                    false,

                productCount:
                    0,

                error:
                    error?.message ||
                    "Unable to connect to CJ Dropshipping."

            });
        }
    }
);


/* =========================================================
   SINGLE PRODUCT ROUTE
   ========================================================= */

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


        res.status(
            500
        ).json({

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
                `http://localhost:${PORT}/api/cj-products?keyword=hoodie&size=1`
            );

            console.log("");

            console.log(
                "CJ Status:"
            );

            console.log(
                `http://localhost:${PORT}/api/cj-status`
            );

            console.log("");

            console.log(
                "CJ API:"
            );

            console.log(
                CJ_API_BASE
            );

            console.log("");

            console.log(
                "========================================"
            );
        }
    );
}


module.exports = app;
