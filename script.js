/* =====================================================
   SUPABASE CONNECTION
===================================================== */

const SUPABASE_URL =
    'https://kqhuobmzpbokxzwkncml.supabase.co';

const SUPABASE_PUBLISHABLE_KEY =
    sb_publishable_OLm0wIyBciSFd8vMPARgmQ_bN5JFQ3D;

const supabaseClient =
    window.supabase.createClient(
        SUPABASE_URL,
        SUPABASE_PUBLISHABLE_KEY
    );


/* =====================================================
   STATE
===================================================== */

let cart =
    JSON.parse(
        localStorage.getItem('globiraCart')
    ) || [];

let currentProduct = null;

let selectedSize = null;


/* =====================================================
   FORMAT PRICE
===================================================== */

function formatPrice(price){

    return '₹' +
        Number(price).toLocaleString('en-IN');

}


/* =====================================================
   SAVE CART
===================================================== */

function saveCart(){

    localStorage.setItem(
        'globiraCart',
        JSON.stringify(cart)
    );

    renderCart();

}


/* =====================================================
   ALL PRODUCTS
===================================================== */

function allProducts(){

    return [
        ...womenProducts,
        ...menProducts
    ];

}


/* =====================================================
   FIND PRODUCT
===================================================== */

function findProduct(id){

    return allProducts().find(
        product => product.id === id
    );

}


/* =====================================================
   FEATURED PRODUCTS
===================================================== */

function renderFeatured(){

    const container =
        document.getElementById(
            'featuredProducts'
        );

    const products = [

        womenProducts[0],
        menProducts[0],
        womenProducts[1],
        menProducts[3],
        womenProducts[2],
        menProducts[2],
        womenProducts[5],
        menProducts[5]

    ];

    container.innerHTML =
        products.map(productCard).join('');

}


/* =====================================================
   PRODUCT CARD
===================================================== */

function productCard(product){

    return `

        <div class="product"
             onclick="openProduct('${product.id}')">

            <div class="product-image">

                <img
                    src="${product.images[0]}"
                    alt="${product.name}"
                >

                <span class="badge">
                    New
                </span>

            </div>


            <div class="product-info">

                <h3>${product.name}</h3>

                <p>
                    GLOBIRA EDIT
                </p>

                <div class="price">

                    ${formatPrice(product.price)}

                    <span class="old-price">

                        ${formatPrice(product.oldPrice)}

                    </span>

                </div>

            </div>

        </div>

    `;

}


/* =====================================================
   CATEGORY PAGE
===================================================== */

function showCategory(category){

    document.getElementById(
        'homePage'
    ).style.display = 'none';


    document
        .getElementById('categoryPage')
        .classList.add('active');


    const products =
        category === 'women'
        ? womenProducts
        : menProducts;


    document.getElementById(
        'categoryTitle'
    ).textContent =
        category === 'women'
        ? 'Women'
        : 'Men';


    document.getElementById(
        'categoryEyebrow'
    ).textContent =
        category === 'women'
        ? 'WOMEN / GLOBIRA COLLECTION'
        : 'MEN / GLOBIRA COLLECTION';


    document.getElementById(
        'categoryProducts'
    ).innerHTML =
        products.map(productCard).join('');


    window.scrollTo({

        top: 0,
        behavior: 'smooth'

    });

}


/* =====================================================
   HOME
===================================================== */

function showHome(){

    document
        .getElementById('categoryPage')
        .classList.remove('active');


    document.getElementById(
        'homePage'
    ).style.display = 'block';


    window.scrollTo({

        top: 0,
        behavior: 'smooth'

    });

}


/* =====================================================
   SIZE SELECTION
===================================================== */

function selectSize(button){

    if(!button) return;


    document
        .querySelectorAll('#productModal .size')
        .forEach(function(btn){

            btn.classList.remove('selected');

        });


    button.classList.add('selected');


    selectedSize =
        button.dataset.size ||
        button.textContent.trim();

}


/* =====================================================
   SELECT SIZE BY VALUE
===================================================== */

function selectSizeByValue(size){

    selectedSize = null;


    document
        .querySelectorAll('#productModal .size')
        .forEach(function(button){

            button.classList.remove('selected');


            const buttonSize =
                button.dataset.size ||
                button.textContent.trim();


            if(buttonSize === size){

                button.classList.add('selected');

                selectedSize = size;

            }

        });

}


/* =====================================================
   CLEAR SIZE
===================================================== */

function clearSizeSelection(){

    selectedSize = null;


    document
        .querySelectorAll('#productModal .size')
        .forEach(function(button){

            button.classList.remove('selected');

        });

}


/* =====================================================
   PRODUCT POPUP
===================================================== */

function openProduct(id, size = null){

    const product =
        findProduct(id);


    if(!product) return;


    currentProduct = product;


    clearSizeSelection();


    document.getElementById(
        'popupName'
    ).textContent =
        product.name;


    document.getElementById(
        'popupPrice'
    ).innerHTML =

        formatPrice(product.price) +

        ' <span class="old-price">' +

        formatPrice(product.oldPrice) +

        '</span>';


    document.getElementById(
        'popupDescription'
    ).textContent =
        product.description;


    document.getElementById(
        'mainProductImage'
    ).src =
        product.images[0];


    const thumbnails =
        document.getElementById(
            'productThumbnails'
        );


    thumbnails.innerHTML =

        product.images.map(function(image){

            return `

                <img
                    src="${image}"
                    alt="${product.name}"
                    onclick="changeMainImage('${image}')"
                >

            `;

        }).join('');


    if(size){

        selectSizeByValue(size);

    }


    document.getElementById(
        'popupAddButton'
    ).onclick = function(){

        const added =
            addToCart(
                product.id,
                selectedSize
            );


        if(added){

            closeProduct();

        }

    };


    document
        .getElementById('productModal')
        .classList.add('active');

}


/* =====================================================
   CHANGE MAIN IMAGE
===================================================== */

function changeMainImage(image){

    document.getElementById(
        'mainProductImage'
    ).src = image;

}


/* =====================================================
   CLOSE PRODUCT
===================================================== */

function closeProduct(){

    document
        .getElementById('productModal')
        .classList.remove('active');


    selectedSize = null;


    document
        .querySelectorAll('#productModal .size')
        .forEach(function(button){

            button.classList.remove('selected');

        });

}


/* =====================================================
   ADD TO CART
===================================================== */

function addToCart(
    id,
    size = selectedSize
){

    const product =
        findProduct(id);


    if(!product){

        return false;

    }


    if(!size){

        alert(
            'Please select a size before adding this product to cart.'
        );

        return false;

    }


    const existing =
        cart.find(function(item){

            return (
                item.id === id &&
                item.size === size
            );

        });


    if(existing){

        existing.quantity += 1;

    }else{

        cart.push({

            id: id,
            size: size,
            quantity: 1

        });

    }


    saveCart();

    openCart();


    return true;

}


/* =====================================================
   CLEAN / FIX CART
===================================================== */

function cleanCart(){

    cart = cart
        .filter(function(item){

            return (
                item &&
                findProduct(item.id) &&
                Number(item.quantity) > 0
            );

        })
        .map(function(item){

            return {

                id: item.id,

                size: item.size || 'M',

                quantity:
                    Number(item.quantity) || 1

            };

        });


    localStorage.setItem(
        'globiraCart',
        JSON.stringify(cart)
    );

}


/* =====================================================
   CHANGE QUANTITY
===================================================== */

function changeQuantity(
    id,
    size,
    amount
){

    const item =
        cart.find(function(item){

            return (
                item.id === id &&
                item.size === size
            );

        });


    if(!item) return;


    item.quantity += amount;


    if(item.quantity <= 0){

        cart =
            cart.filter(function(item){

                return !(
                    item.id === id &&
                    item.size === size
                );

            });

    }


    saveCart();

}


/* =====================================================
   REMOVE ITEM
===================================================== */

function removeItem(
    id,
    size
){

    cart =
        cart.filter(function(item){

            return !(
                item.id === id &&
                item.size === size
            );

        });


    saveCart();

}


/* =====================================================
   RENDER CART
===================================================== */

function renderCart(){

    cleanCart();


    const container =
        document.getElementById(
            'cartItems'
        );


    if(cart.length === 0){

        container.innerHTML = `

            <p style="
                text-align:center;
                color:#888;
                padding:50px 10px;
            ">

                Your cart is empty.

            </p>

        `;

    }else{

        container.innerHTML =

            cart.map(function(item){

                const product =
                    findProduct(item.id);


                if(!product) return '';


                const productId =
                    JSON.stringify(
                        product.id
                    );


                const productSize =
                    JSON.stringify(
                        item.size
                    );


                return `

                    <div class="cart-item">

                        <img
                            src="${product.images[0]}"
                            alt="${product.name}"
                            onclick="openProduct(
                                ${productId},
                                ${productSize}
                            )"
                            style="cursor:pointer"
                        >


                        <div class="cart-item-info">

                            <h4
                                onclick="openProduct(
                                    ${productId},
                                    ${productSize}
                                )"
                            >

                                ${product.name}

                            </h4>


                            <div style="
                                font-size:12px;
                                color:#777;
                                margin-bottom:7px;
                            ">

                                Size: ${item.size}

                            </div>


                            <div class="cart-price">

                                ${formatPrice(
                                    product.price
                                )}

                            </div>


                            <div class="quantity">

                                <button
                                    onclick='changeQuantity(
                                        ${productId},
                                        ${productSize},
                                        -1
                                    )'
                                >

                                    −

                                </button>


                                <span>

                                    ${item.quantity}

                                </span>


                                <button
                                    onclick='changeQuantity(
                                        ${productId},
                                        ${productSize},
                                        1
                                    )'
                                >

                                    +

                                </button>

                            </div>


                            <button
                                class="remove"
                                onclick='removeItem(
                                    ${productId},
                                    ${productSize}
                                )'
                            >

                                REMOVE

                            </button>

                        </div>

                    </div>

                `;

            }).join('');

    }


    let quantity = 0;

    let total = 0;


    cart.forEach(function(item){

        const product =
            findProduct(item.id);


        if(!product) return;


        const itemQuantity =
            Number(item.quantity) || 0;


        quantity += itemQuantity;


        total +=
            product.price *
            itemQuantity;

    });


    document.getElementById(
        'cartCount'
    ).textContent =
        quantity;


    document.getElementById(
        'cartTotal'
    ).textContent =
        formatPrice(total);

}


/* =====================================================
   OPEN CART
===================================================== */

function openCart(){

    renderCart();


    document
        .getElementById('cartDrawer')
        .classList.add('active');


    document
        .getElementById('overlay')
        .classList.add('active');

}


/* =====================================================
   CLOSE CART
===================================================== */

function closeCart(){

    document
        .getElementById('cartDrawer')
        .classList.remove('active');


    document
        .getElementById('overlay')
        .classList.remove('active');

}


/* =====================================================
   OVERLAY
===================================================== */

function overlayClose(){

    closeCart();

}


/* =====================================================
   CHECKOUT
===================================================== */

function openCheckout(){

    if(cart.length === 0){

        alert('Your cart is empty.');

        return;

    }


    closeCart();


    renderReview();


    document
        .getElementById('checkoutModal')
        .classList.add('active');


    showStep(1);

}


/* =====================================================
   CLOSE CHECKOUT
===================================================== */

function closeCheckout(){

    document
        .getElementById('checkoutModal')
        .classList.remove('active');

}


/* =====================================================
   CHECKOUT REVIEW
===================================================== */

function renderReview(){

    const container =
        document.getElementById(
            'checkoutReview'
        );


    let total = 0;


    container.innerHTML =

        cart.map(function(item){

            const product =
                findProduct(item.id);


            if(!product) return '';


            const itemTotal =
                product.price *
                item.quantity;


            total += itemTotal;


            return `

                <div class="review-line">

                    <span>

                        ${product.name}

                        <small style="
                            display:block;
                            color:#777;
                            font-size:11px;
                            margin-top:4px;
                        ">

                            Size: ${item.size}

                            × ${item.quantity}

                        </small>

                    </span>


                    <strong>

                        ${formatPrice(itemTotal)}

                    </strong>

                </div>

            `;

        }).join('');


    container.innerHTML += `

        <div
            class="review-line"
            style="
                font-size:18px;
                margin-top:10px
            "
        >

            <strong>
                Total
            </strong>


            <strong>

                ${formatPrice(total)}

            </strong>

        </div>

    `;

}


/* =====================================================
   SHOW CHECKOUT STEP
===================================================== */

function showStep(step){

    document
        .querySelectorAll('.checkout-step')
        .forEach(function(el){

            el.classList.remove('active');

        });


    document
        .getElementById(
            'step' + step
        )
        .classList.add('active');


    document
        .querySelectorAll('.step')
        .forEach(function(el){

            el.classList.remove('active');

        });


    document
        .getElementById(
            'stepLabel' + step
        )
        .classList.add('active');

}


/* =====================================================
   DELIVERY
===================================================== */

function goToDelivery(){

    showStep(2);

}


/* =====================================================
   PAYMENT
===================================================== */

function goToPayment(){

    const name =
        document.getElementById(
            'customerName'
        ).value.trim();


    const mobile =
        document.getElementById(
            'customerMobile'
        ).value.trim();


    const address =
        document.getElementById(
            'customerAddress'
        ).value.trim();


    const city =
        document.getElementById(
            'customerCity'
        ).value.trim();


    const pin =
        document.getElementById(
            'customerPin'
        ).value.trim();


    if(
        !name ||
        !mobile ||
        !address ||
        !city ||
        !pin
    ){

        alert(
            'Please complete all delivery details.'
        );

        return;

    }


    showStep(3);

}


/* =====================================================
   PLACE ORDER
===================================================== */

function placeOrder(){

    const payment =
        document.querySelector(
            'input[name="payment"]:checked'
        );


    if(!payment){

        alert(
            'Please select a payment method.'
        );

        return;

    }


    const orderID =

        'GLO' +

        Math.floor(
            100000 +
            Math.random() * 900000
        );


    document
        .getElementById(
            'orderNumber'
        )
        .textContent =

        'Order ID: ' + orderID;


    showStep(4);

}


/* =====================================================
   FINISH ORDER
===================================================== */

function finishOrder(){

    cart = [];


    saveCart();


    closeCheckout();


    showHome();

}


/* =====================================================
   INITIALIZE
===================================================== */

renderFeatured();

renderCart();


/* =====================================================
   ESCAPE KEY
===================================================== */

document.addEventListener(
    'keydown',
    function(event){

        if(event.key === 'Escape'){

            closeProduct();

            closeCart();

            closeCheckout();

        }

    }
);