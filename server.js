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
