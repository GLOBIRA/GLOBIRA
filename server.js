const express = require("express");
const path = require("path");

const app = express();

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;

const CJ_API_BASE =
    "https://developers.cjdropshipping.com/api2.0/v1";

/* =========================================================
   CJ AUTHENTICATION
   ========================================================= */

let cjAccessToken = null;
let cjRefreshToken = null;
let cjTokenExpiresAt = 0;
let cjRefreshTokenExpiresAt = 0;

function parseExpiry(value, fallbackMs) {
    const parsed = value ? Date.parse(value) : NaN;

    if (Number.isFinite(parsed)) {
        return parsed;
    }

    return Date.now() + fallbackMs;
}

async function getCJAccessToken() {
    const apiKey = process.env.CJ_API_KEY;

    /*
     * Optional direct access-token support.
     * CJ_API_KEY is preferred when available.
     */
    const directAccessToken = process.env.CJ_ACCESS_TOKEN;

    /*
     * IMPORTANT:
     * CJ_API_KEY is NOT itself the CJ-Access-Token.
     * It must first be exchanged through:
     * /authentication/getAccessToken
     */

    if (!apiKey && directAccessToken) {
        cjAccessToken = directAccessToken;
        cjTokenExpiresAt =
            Date.now() + 60 * 60 * 1000;

        return cjAccessToken;
    }

    if (!apiKey) {
        throw new Error(
            "CJ_API_KEY is missing. Add CJ_API_KEY to Vercel Environment Variables."
        );
    }

    /*
     * Reuse existing access token while valid.
     */
    if (
        cjAccessToken &&
        Date.now() < cjTokenExpiresAt - 60 * 1000
    ) {
        return cjAccessToken;
    }

    /*
     * Try refresh token first.
     */
    if (
        cjRefreshToken &&
        Date.now() <
            cjRefreshTokenExpiresAt - 60 * 1000
    ) {
        try {
            const refreshResponse = await fetch(
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

            const refreshJson =
                await refreshResponse.json();

            if (
                refreshResponse.ok &&
                refreshJson &&
                refreshJson.code === 200 &&
                refreshJson.data &&
                refreshJson.data.accessToken
            ) {
                const data = refreshJson.data;

                cjAccessToken =
                    data.accessToken;

                cjRefreshToken =
                    data.refreshToken ||
                    cjRefreshToken;

                cjTokenExpiresAt =
                    parseExpiry(
                        data.accessTokenExpiryDate,
                        180 * 24 * 60 * 60 * 1000
                    );

                cjRefreshTokenExpiresAt =
                    parseExpiry(
                        data.refreshTokenExpiryDate,
                        180 * 24 * 60 * 60 * 1000
                    );

                console.log(
                    "GLOBIRA: CJ access token refreshed successfully."
                );

                return cjAccessToken;
            }
        } catch (error) {
            console.error(
                "GLOBIRA CJ TOKEN REFRESH ERROR:",
                error.message
            );
        }
    }

    /*
     * Get a fresh access token using the CJ API key.
     *
     * CJ requires:
     * {
     *   "apiKey": "YOUR_CJ_API_KEY"
     * }
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
                apiKey: apiKey
            })
        }
    );

    let json;

    try {
        json = await response.json();
    } catch (error) {
        throw new Error(
            `CJ authentication returned invalid JSON. HTTP ${response.status}`
        );
    }

    if (
        !response.ok ||
        !json ||
        json.code !== 200 ||
        !json.data ||
        !json.data.accessToken
    ) {
        const cjCode =
            json && json.code
                ? json.code
                : response.status;

        const cjMessage =
            json && json.message
                ? json.message
                : "Unknown CJ authentication error.";

        throw new Error(
            `CJ authentication failed (${cjCode}): ${cjMessage}`
        );
    }

    const data = json.data;

    cjAccessToken =
        data.accessToken;

    cjRefreshToken =
        data.refreshToken ||
        null;

    cjTokenExpiresAt =
        parseExpiry(
            data.accessTokenExpiryDate,
            180 * 24 * 60 * 60 * 1000
        );

    cjRefreshTokenExpiresAt =
        parseExpiry(
            data.refreshTokenExpiryDate,
            180 * 24 * 60 * 60 * 1000
        );

    console.log(
        "GLOBIRA: CJ access token obtained successfully."
    );

    return cjAccessToken;
}


/* =========================================================
   CJ REQUEST QUEUE
   ========================================================= */

let cjRequestQueue =
    Promise.resolve();

let cjLastRequestAt = 0;

function sleep(ms) {
    return new Promise(resolve =>
        setTimeout(resolve, ms)
    );
}

async function cjGet(url, options = {}) {
    const runRequest = async () => {
        const maxRetries = 5;

        for (
            let attempt = 1;
            attempt <= maxRetries;
            attempt++
        ) {
            try {
                /*
                 * CJ has a QPS limit.
                 * Keep requests at least ~1.1 seconds apart.
                 */
                const elapsed =
                    Date.now() -
                    cjLastRequestAt;

                const waitTime =
                    Math.max(
                        0,
                        1100 - elapsed
                    );

                if (waitTime > 0) {
                    await sleep(waitTime);
                }

                const token =
                    await get
