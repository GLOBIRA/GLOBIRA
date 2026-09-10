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
// MIDDLEWARE
// ========================================

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ========================================
// SUPPLIER DATABASE
// ========================================

function ensureSupplierFile() {
    if (!fs.existsSync(SUPPLIERS_FILE)) {
        fs.writeFileSync(
            SUPPLIERS_FILE,
            JSON.stringify([], null, 2),
            "utf8"
        );
    }
}

function getSuppliers() {
    ensureSupplierFile();

    try {
        const data = fs.readFileSync(
            SUPPLIERS_FILE,
            "utf8"
        );

        return JSON.parse(data);

    } catch (error) {
        console.error("SUPPLIER DATABASE ERROR:", error);
        return [];
    }
}

function saveSuppliers(suppliers) {
    fs.writeFileSync(
        SUPPLIERS_FILE,
        JSON.stringify(suppliers, null, 2),
        "utf8"
    );
}

ensureSupplierFile();

// ========================================
// PASSWORD SECURITY
// ========================================

function hashPassword(password) {

    const salt = crypto.randomBytes(16).toString("hex");

    const hash = crypto
        .pbkdf2Sync(
            password,
            salt,
            100000,
            64,
            "sha512"
        )
        .toString("hex");

    return {
        salt: salt,
        hash: hash
    };
}

function verifyPassword(password, storedHash, salt) {

    const hash = crypto
        .pbkdf2Sync(
            password,
            salt,
            100000,
            64,
            "sha512"
        )
        .toString("hex");

    return crypto.timingSafeEqual(
        Buffer.from(hash, "hex"),
        Buffer.from(storedHash, "hex")
    );
}

// ========================================
// SESSION SYSTEM
// ========================================

const sessions = new Map();

function createSession(supplierId) {

    const token = crypto
        .randomBytes(32)
        .toString("hex");

    sessions.set(token, {
        supplierId: supplierId,
        createdAt: Date.now()
    });

    return token;
}

function getSessionToken(req) {

    const cookieHeader = req.headers.cookie;

    if (!cookieHeader) {
        return null;
    }

    const cookies = cookieHeader
        .split(";")
        .map(function(cookie) {
            return cookie.trim();
        });

    const sessionCookie = cookies.find(function(cookie) {
        return cookie.startsWith(
            "yadhuvii_supplier_session="
        );
    });

    if (!sessionCookie) {
        return null;
    }

    return sessionCookie.split("=")[1];
}

function getLoggedInSupplier(req) {

    const token = getSessionToken(req);

    if (!token) {
        return null;
    }

    const session = sessions.get(token);

    if (!session) {
        return null;
    }

    const suppliers = getSuppliers();

    return suppliers.find(function(supplier) {
        return supplier.id === session.supplierId;
    }) || null;
}

// ========================================
// AUTHENTICATION MIDDLEWARE
// ========================================

function requireSupplierAuth(req, res, next) {

    const supplier = getLoggedInSupplier(req);

    if (!supplier) {

        if (
            req.path === "/supplier-dashboard.html" ||
            req.path === "/api/supplier/me"
        ) {

            return res.status(401).json({
                success: false,
                authenticated: false,
                message: "Please login first."
            });
        }

        return res.status(401).json({
            success: false,
            message: "Supplier authentication required."
        });
    }

    req.supplier = supplier;

    next();
}

// ========================================
// WEBSITE FILES
// ========================================

// IMPORTANT:
// Dashboard authentication route comes BEFORE
// express.static so the dashboard is protected.

app.get("/supplier-dashboard.html", function(req, res) {

    const supplier = getLoggedInSupplier(req);

    if (!supplier) {
        return res.redirect("/supplier.html");
    }

    res.sendFile(
        path.join(__dirname, "supplier-dashboard.html")
    );
});

app.use(express.static(__dirname));

// ========================================
// HOME
// ========================================

app.get("/", function(req, res) {

    res.sendFile(
        path.join(__dirname, "index.html")
    );

});

// ========================================
// PRODUCT PAGE
// ========================================

app.get("/product.html", function(req, res) {

    res.sendFile(
        path.join(__dirname, "product.html")
    );

});

// ========================================
// HEALTH CHECK
// ========================================

app.get("/api/test", function(req, res) {

    res.json({
        success: true,
        message: "YADHUVII backend is working",
        shop_id: SHOP_ID
    });

});

// ========================================
// SUPPLIER REGISTRATION
// ========================================

app.post("/api/supplier/register", function(req, res) {

    try {

        const {
            businessName,
            contactPerson,
            email,
            phone,
            country,
            category,
            website,
            password
        } = req.body;

        // --------------------------------
        // VALIDATION
        // --------------------------------

        if (
            !businessName ||
            !contactPerson ||
            !email ||
            !password
        ) {

            return res.status(400).json({
                success: false,
                message:
                    "Business name, contact person, email and password are required."
            });
        }

        if (password.length < 8) {

            return res.status(400).json({
                success: false,
                message:
                    "Password must contain at least 8 characters."
            });
        }

        const cleanEmail =
            String(email).trim().toLowerCase();

        const suppliers = getSuppliers();

        // --------------------------------
        // CHECK EXISTING EMAIL
        // --------------------------------

        const existingSupplier =
            suppliers.find(function(supplier) {

                return supplier.email === cleanEmail;

            });

        if (existingSupplier) {

            return res.status(409).json({
                success: false,
                message:
                    "A supplier account with this email already exists."
            });
        }

        // --------------------------------
        // PASSWORD HASH
        // --------------------------------

        const passwordData =
            hashPassword(password);

        // --------------------------------
        // CREATE SUPPLIER
        // --------------------------------

        const supplier = {

            id:
                "SUP-" +
                Date.now() +
                "-" +
                crypto.randomBytes(3).toString("hex"),

            businessName:
                String(businessName).trim(),

            contactPerson:
                String(contactPerson).trim(),

            email:
                cleanEmail,

            phone:
                phone ? String(phone).trim() : "",

            country:
                country ? String(country).trim() : "",

            category:
                category ? String(category).trim() : "",

            website:
                website ? String(website).trim() : "",

            passwordHash:
                passwordData.hash,

            passwordSalt:
                passwordData.salt,

            status:
                "pending",

            currency:
                "INR",

            products:
                [],

            orders:
                [],

            createdAt:
                new Date().toISOString()

        };

        suppliers.push(supplier);

        saveSuppliers(suppliers);

        console.log("");
        console.log("================================");
        console.log("NEW SUPPLIER REGISTERED");
        console.log("================================");
        console.log("Supplier:", supplier.businessName);
        console.log("Email:", supplier.email);
        console.log("ID:", supplier.id);
        console.log("================================");
        console.log("");

        return res.status(201).json({

            success: true,

            message:
                "Supplier account created successfully.",

            supplier: {

                id:
                    supplier.id,

                businessName:
                    supplier.businessName,

                contactPerson:
                    supplier.contactPerson,

                email:
                    supplier.email,

                status:
                    supplier.status,

                currency:
                    supplier.currency

            }

        });

    } catch (error) {

        console.error(
            "SUPPLIER REGISTRATION ERROR:",
            error
        );

        return res.status(500).json({

            success: false,

            message:
                "Unable to create supplier account."

        });

    }

});// ========================================
// SUPPLIER LOGIN
// ========================================

app.post("/api/supplier/login", function(req, res) {

    try {

        const {
            email,
            password
        } = req.body;

        if (!email || !password) {

            return res.status(400).json({

                success: false,

                message:
                    "Email and password are required."

            });

        }

        const cleanEmail =
            String(email).trim().toLowerCase();

        const suppliers = getSuppliers();

        const supplier =
            suppliers.find(function(item) {

                return item.email === cleanEmail;

            });

        if (!supplier) {

            return res.status(401).json({

                success: false,

                message:
                    "Invalid email or password."

            });

        }

        const validPassword =
            verifyPassword(
                password,
                supplier.passwordHash,
                supplier.passwordSalt
            );

        if (!validPassword) {

            return res.status(401).json({

                success: false,

                message:
                    "Invalid email or password."

            });

        }

        // --------------------------------
        // CREATE LOGIN SESSION
        // --------------------------------

        const token =
            createSession(supplier.id);

        res.setHeader(
            "Set-Cookie",
            "yadhuvii_supplier_session=" +
            token +
            "; HttpOnly; Path=/; SameSite=Lax"
        );

        console.log("");
        console.log("================================");
        console.log("SUPPLIER LOGIN");
        console.log("================================");
        console.log("Business:", supplier.businessName);
        console.log("Email:", supplier.email);
        console.log("================================");
        console.log("");

        return res.json({

            success: true,

            message:
                "Login successful.",

            supplier: {

                id:
                    supplier.id,

                businessName:
                    supplier.businessName,

                contactPerson:
                    supplier.contactPerson,

                email:
                    supplier.email,

                status:
                    supplier.status,

                currency:
                    supplier.currency

            }

        });

    } catch (error) {

        console.error(
            "SUPPLIER LOGIN ERROR:",
            error
        );

        return res.status(500).json({

            success: false,

            message:
                "Unable to login."

        });

    }

});


// ========================================
// GET CURRENT SUPPLIER
// ========================================

app.get(
    "/api/supplier/me",
    requireSupplierAuth,
    function(req, res) {

        return res.json({

            success: true,

            authenticated: true,

            supplier: {

                id:
                    req.supplier.id,

                businessName:
                    req.supplier.businessName,

                contactPerson:
                    req.supplier.contactPerson,

                email:
                    req.supplier.email,

                phone:
                    req.supplier.phone,

                country:
                    req.supplier.country,

                category:
                    req.supplier.category,

                website:
                    req.supplier.website,

                status:
                    req.supplier.status,

                currency:
                    req.supplier.currency,

                createdAt:
                    req.supplier.createdAt

            }

        });

    }
);


// ========================================
// SUPPLIER LOGOUT
// ========================================

app.post("/api/supplier/logout", function(req, res) {

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

        success: true,

        message:
            "Logged out successfully."

    });

});


// ========================================
// UPDATE SUPPLIER PROFILE
// ========================================

app.put(
    "/api/supplier/profile",
    requireSupplierAuth,
    function(req, res) {

        try {

            const suppliers = getSuppliers();

            const supplierIndex =
                suppliers.findIndex(function(item) {

                    return item.id === req.supplier.id;

                });

            if (supplierIndex === -1) {

                return res.status(404).json({

                    success: false,

                    message:
                        "Supplier not found."

                });

            }

            const supplier =
                suppliers[supplierIndex];

            const {
                businessName,
                contactPerson,
                phone,
                country,
                category,
                website
            } = req.body;

            if (businessName !== undefined) {

                supplier.businessName =
                    String(businessName).trim();

            }

            if (contactPerson !== undefined) {

                supplier.contactPerson =
                    String(contactPerson).trim();

            }

            if (phone !== undefined) {

                supplier.phone =
                    String(phone).trim();

            }

            if (country !== undefined) {

                supplier.country =
                    String(country).trim();

            }

            if (category !== undefined) {

                supplier.category =
                    String(category).trim();

            }

            if (website !== undefined) {

                supplier.website =
                    String(website).trim();

            }

            suppliers[supplierIndex] =
                supplier;

            saveSuppliers(suppliers);

            return res.json({

                success: true,

                message:
                    "Supplier profile updated successfully.",

                supplier: {

                    id:
                        supplier.id,

                    businessName:
                        supplier.businessName,

                    contactPerson:
                        supplier.contactPerson,

                    email:
                        supplier.email,

                    phone:
                        supplier.phone,

                    country:
                        supplier.country,

                    category:
                        supplier.category,

                    website:
                        supplier.website,

                    status:
                        supplier.status,

                    currency:
                        supplier.currency

                }

            });

        } catch (error) {

            console.error(
                "PROFILE UPDATE ERROR:",
                error
            );

            return res.status(500).json({

                success: false,

                message:
                    "Unable to update profile."

            });

        }

    }
);


// ========================================
// SUPPLIER PRODUCTS
// ========================================

app.get(
    "/api/supplier/products",
    requireSupplierAuth,
    function(req, res) {

        return res.json({

            success: true,

            currency: "INR",

            products:
                req.supplier.products || []

        });

    }
);// ========================================
// TEST PRINTIFY CONNECTION
// ========================================

app.get("/test-printify", async function(req, res) {

    try {

        const token =
            process.env.PRINTIFY_API_TOKEN;

        if (!token) {

            return res.status(500).json({

                success: false,

                error:
                    "PRINTIFY_API_TOKEN is missing from .env"

            });

        }

        console.log(
            "Testing Printify connection..."
        );

        console.log(
            "Token loaded:",
            true
        );

        console.log(
            "Token length:",
            token.length
        );

        const response =
            await fetch(
                "https://api.printify.com/v1/shops.json",
                {
                    method: "GET",

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
            "Printify status:",
            response.status
        );

        let data;

        try {

            data =
                JSON.parse(text);

        } catch (error) {

            data = {
                response: text
            };

        }

        if (!response.ok) {

            return res
                .status(response.status)
                .json({

                    success: false,

                    printify_status:
                        response.status,

                    printify_response:
                        data

                });

        }

        return res.json({

            success: true,

            message:
                "PRINTIFY CONNECTED SUCCESSFULLY",

            data:
                data

        });

    } catch (error) {

        console.error(
            "PRINTIFY ERROR:",
            error
        );

        return res.status(500).json({

            success: false,

            error:
                error.message

        });

    }

});


// ========================================
// GET ALL PRINTIFY PRODUCTS
// ========================================

async function getPrintifyProducts(req, res) {

    try {

        const token =
            process.env.PRINTIFY_API_TOKEN;

        if (!token) {

            console.error(
                "ERROR: PRINTIFY_API_TOKEN missing"
            );

            return res.status(500).json({

                success: false,

                error:
                    "PRINTIFY_API_TOKEN is missing from .env"

            });

        }

        console.log("");
        console.log(
            "================================"
        );
        console.log(
            "GETTING PRINTIFY PRODUCTS"
        );
        console.log(
            "================================"
        );
        console.log(
            "Shop ID:",
            SHOP_ID
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
                    method: "GET",

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
                JSON.parse(text);

        } catch (error) {

            console.error(
                "Could not parse Printify response"
            );

            return res.status(500).json({

                success: false,

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

            console.error(data);

            return res
                .status(response.status)
                .json({

                    success: false,

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

            success: true,

            shop_id:
                SHOP_ID,

            products:
                data

        });

    } catch (error) {

        console.error("");
        console.error(
            "================================"
        );
        console.error(
            "PRODUCTS ERROR"
        );
        console.error(
            "================================"
        );
        console.error(error);

        return res.status(500).json({

            success: false,

            error:
                error.message

        });

    }

}


// ========================================
// PRODUCT ROUTES
// ========================================

app.get(
    "/api/products",
    getPrintifyProducts
);

app.get(
    "/printify-products",
    getPrintifyProducts
);// ========================================
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

                return res.status(500).json({

                    success: false,

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
                        method: "GET",

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
                    JSON.parse(text);

            } catch (error) {

                return res.status(500).json({

                    success: false,

                    error:
                        "Invalid response from Printify",

                    response:
                        text

                });

            }

            if (!response.ok) {

                return res
                    .status(response.status)
                    .json({

                        success: false,

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
                    .map(function(image) {

                        return {

                            src:
                                image.src,

                            position:
                                image.position

                        };

                    }),

                variants:
                    (data.variants || [])
                    .map(function(variant) {

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
                                variant.sku || null

                        };

                    }),

                prices:
                    (data.variants || [])
                    .map(function(variant) {

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

                    }),

                availability:
                    (data.variants || [])
                    .map(function(variant) {

                        return {

                            variant_id:
                                variant.id,

                            variant:
                                variant.title,

                            available:
                                variant.is_enabled

                        };

                    })

            };

            return res.json({

                success: true,

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

            return res.status(500).json({

                success: false,

                error:
                    error.message

            });

        }

    }
);


// ========================================
// 404 HANDLER
// ========================================

app.use(function(req, res) {

    res.status(404).json({

        success: false,

        error:
            "Route not found",

        requested_url:
            req.originalUrl

    });

});


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
            "          YADHUVII SERVER"
        );
        console.log(
            "========================================"
        );

        console.log(
            "Server:   http://localhost:" +
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
            "Supplier Portal:"
        );

        console.log(
            "http://localhost:" +
            PORT +
            "/supplier.html"
        );

        console.log("");

        console.log(
            "Supplier Dashboard:"
        );

        console.log(
            "http://localhost:" +
            PORT +
            "/supplier-dashboard.html"
        );

        console.log("");

        console.log(
            "API Products:"
        );

        console.log(
            "http://localhost:" +
            PORT +
            "/api/products"
        );

        console.log("");

        console.log(
            "Printify Test:"
        );

        console.log(
            "http://localhost:" +
            PORT +
            "/test-printify"
        );

        console.log("");

        console.log(
            "Backend Test:"
        );

        console.log(
            "http://localhost:" +
            PORT +
            "/api/test"
        );

        console.log("");

        console.log(
            "Shop ID:",
            SHOP_ID
        );

        console.log(
            "Currency:",
            "INR"
        );

        console.log(
            "========================================"
        );

        console.log("");

    }
);