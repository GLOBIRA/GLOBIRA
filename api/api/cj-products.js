module.exports = async function handler(req, res) {
    try {
        res.setHeader("Access-Control-Allow-Origin", "*");

        const apiKey = process.env.CJ_API_KEY;

        if (!apiKey) {
            return res.status(500).json({
                success: false,
                error: "CJ_API_KEY is not configured in Vercel."
            });
        }

        const keyword = String(
            req.query.keyword || "hoodie"
        ).trim();

        const size = Math.min(
            Math.max(
                Number(req.query.size) || 6,
                1
            ),
            20
        );

        const authResponse = await fetch(
            "https://developers.cjdropshipping.com/api2.0/v1/authentication/getAccessToken",
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    apiKey
                })
            }
        );

        const authJson = await authResponse.json();

        if (
            !authResponse.ok ||
            !authJson?.result ||
            !authJson?.data?.accessToken
        ) {
            return res.status(500).json({
                success: false,
                error:
                    authJson?.message ||
                    "CJ authentication failed"
            });
        }

        const token = authJson.data.accessToken;

        const listUrl = new URL(
            "https://developers.cjdropshipping.com/api2.0/v1/product/listV2"
        );

        listUrl.searchParams.set("page", "1");
        listUrl.searchParams.set("size", String(size));
        listUrl.searchParams.set("keyWord", keyword);
        listUrl.searchParams.set(
            "features",
            "enable_description,enable_category"
        );
        listUrl.searchParams.set("sort", "desc");
        listUrl.searchParams.set("orderBy", "0");

        const listResponse = await fetch(
            listUrl.toString(),
            {
                headers: {
                    "CJ-Access-Token": token
                }
            }
        );

        const listJson = await listResponse.json();

        if (
            !listResponse.ok ||
            listJson?.result === false
        ) {
            return res.status(500).json({
                success: false,
                error:
                    listJson?.message ||
                    "CJ product list request failed"
            });
        }

        const content =
            listJson?.data?.content || [];

        const products =
            content.flatMap(
                item => item?.productList || []
            );

        const normalized = await Promise.all(
            products
                .slice(0, size)
                .map(async product => {

                    let source = product;

                    try {
                        const detailUrl = new URL(
                            "https://developers.cjdropshipping.com/api2.0/v1/product/query"
                        );

                        detailUrl.searchParams.set(
                            "pid",
                            product.id
                        );

                        const detailResponse =
                            await fetch(
                                detailUrl.toString(),
                                {
                                    headers: {
                                        "CJ-Access-Token":
                                            token
                                    }
                                }
                            );

                        const detailJson =
                            await detailResponse.json();

                        if (
                            detailResponse.ok &&
                            detailJson?.result &&
                            detailJson?.data
                        ) {
                            source =
                                detailJson.data;
                        }

                    } catch (error) {
                        console.warn(
                            "CJ detail failed:",
                            error.message
                        );
                    }

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
                            "Premium quality product from GLOBIRA.",

                        images:
                            images.length
                                ? images
                                : [
                                    "https://via.placeholder.com/900x1200?text=CJ+Product"
                                ],

                        price: rawPrice,

                        oldPrice: rawPrice,

                        variants:
                            Array.isArray(
                                source.variants
                            )
                                ? source.variants
                                : [],

                        source:
                            "cjdropshipping"
                    };
                })
        );

        return res.json({
            success: true,
            source: "cjdropshipping",
            keyword,
            products: normalized
        });

    } catch (error) {

        console.error(
            "CJ PRODUCTS ERROR:",
            error
        );

        return res.status(500).json({
            success: false,
            source: "cjdropshipping",
            error: error.message
        });
    }
};
