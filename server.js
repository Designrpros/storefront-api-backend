require('dotenv').config();
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const cors = require('cors');
const nodemailer = require('nodemailer');
// Assuming you've initialized Firebase Admin SDK correctly somewhere above this line
const admin = require('firebase-admin');
const {google} = require('googleapis');

console.log("Stripe Secret Key:", process.env.STRIPE_SECRET_KEY);

const app = express();

app.use(cors());

admin.initializeApp({
  credential: admin.credential.cert({
    type: process.env.FIREBASE_TYPE,
    project_id: process.env.FIREBASE_PROJECT_ID,
    private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
    private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    client_email: process.env.FIREBASE_CLIENT_EMAIL,
    client_id: process.env.FIREBASE_CLIENT_ID,
    auth_uri: process.env.FIREBASE_AUTH_URI,
    token_uri: process.env.FIREBASE_TOKEN_URI,
    auth_provider_x509_cert_url: process.env.FIREBASE_AUTH_PROVIDER_X509_CERT_URL,
    client_x509_cert_url: process.env.FIREBASE_CLIENT_X509_CERT_URL
  })
});

const db = admin.firestore();

// Apply JSON middleware globally except for the webhook route
app.use((req, res, next) => {
  if (req.originalUrl === '/webhook') {
    next();
  } else {
    express.json()(req, res, next);
  }
});

const corsOptions = {
  origin: 'https://h-l-i-c-ven.vercel.app',
  optionsSuccessStatus: 200 // some legacy browsers (IE11, various SmartTVs) choke on 204
};

app.use(cors(corsOptions));


// OAuth2 client setup
const oAuth2Client = new google.auth.OAuth2(
  process.env.CLIENT_ID,
  process.env.CLIENT_SECRET,
  process.env.REDIRECT_URI
);
oAuth2Client.setCredentials({ refresh_token: process.env.REFRESH_TOKEN });

async function sendMail(email, subject, message) {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.GMAIL_USER, // Your Gmail address
      pass: process.env.GMAIL_APP_PASSWORD // Your App Password
    }
  });

  const mailOptions = {
    from: `Høl i CVen <${process.env.GMAIL_USER}>`, // Sender address
    to: email, // List of recipients
    subject: subject, // Subject line
    text: message, // Plain text body
    html: `<p>${message}</p>`, // HTML body
  };

  try {
    const result = await transporter.sendMail(mailOptions);
    console.log('Email sent:', result);
    return result;
  } catch (error) {
    console.error('Failed to send email', error);
  }
}


app.post('/create-checkout-session', async (req, res) => {
  console.log("Received request for checkout session creation:", req.body);

  const { cartItems, shippingDetails } = req.body;

  const lineItems = cartItems.map(item => {
    const priceMatch = item.price.match(/(\d+([.,]\d+)?)/);
    let priceInCents = 0;
    if (priceMatch) {
      const priceAsNumber = parseFloat(priceMatch[0].replace(',', '.'));
      priceInCents = Math.round(priceAsNumber * 100);
    }

    return {
      price_data: {
        currency: 'nok',
        product_data: {
          name: item.name,
        },
        unit_amount: priceInCents,
      },
      quantity: item.quantity,
    };
  });

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: lineItems,
      mode: 'payment',
      success_url: `${req.headers.origin}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${req.headers.origin}/cancel`,
      shipping_address_collection: {
        allowed_countries: ['NO'],
      },
      metadata: {
        customerEmail: shippingDetails.email,
      },
    });

    console.log("Stripe session created:", session);
    res.json({ id: session.id });
  } catch (error) {
    console.error("Error creating Stripe checkout session:", error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/webhook', express.raw({type: 'application/json'}), async (request, response) => {
  const sig = request.headers['stripe-signature'];

  let event;

  try {
    event = stripe.webhooks.constructEvent(request.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error(`Webhook signature verification failed.`, err.message);
    return response.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    
    // Retrieve the session with expanded line items and their associated products
    const fullSession = await stripe.checkout.sessions.retrieve(session.id, {
      expand: ['line_items.data.price.product']
    });

    // Extract product names, quantities, and other relevant details
    const productsPurchased = fullSession.line_items.data.map(item => ({
      name: item.price.product.name,
      quantity: item.quantity,
      unitPrice: item.price.unit_amount,
      totalPrice: item.amount_total
    }));

    // Access shipping details directly from the session object
    const shippingDetails = session.shipping ? {
      name: session.shipping.name,
      address: session.shipping.address
    } : "no shipping details available";

    // Construct the order object to save to Firestore
    const order = {
      customerId: session.customer,
      email: session.customer_details.email,
      productsPurchased,
      shippingDetails,
      totalAmount: session.amount_total,
      currency: session.currency,
      status: 'completed',
      createdAt: admin.firestore.FieldValue.serverTimestamp() // Use server timestamp
    };

    // Save the order to Firestore
    try {
      await db.collection('orders').doc(session.id).set(order);
      console.log(`Order ${session.id} saved to Firestore.`);
    } catch (error) {
      console.error('Error saving order to Firestore:', error);
    }
      
  
      // Extract product names and quantities
      const productDetails = fullSession.line_items.data.map(item => {
        const productName = item.price.product.name; // Assuming product name is stored here
        return `${productName} - Quantity: ${item.quantity}`;
      }).join('<br>');
  
  
      // Construct email messages
      const messageForCustomer = `
        <h1>Order Confirmation</h1>
        <p>Thank you for your order!</p>
        <p>Order Number: ${session.id}</p>
        <p>Products:<br>${productDetails}</p>
        <p>Total Amount: ${(session.amount_total / 100).toFixed(2)} ${session.currency.toUpperCase()}</p>
        <p>Shipping Details:<br>${shippingDetails}</p>
      `;
  
      const messageForShopOwner = `
        <h1>New Order Received</h1>
        <p>A new order has been placed. Order Number: ${session.id}</p>
        <p>Products:<br>${productDetails}</p>
        <p>Total Amount: ${(session.amount_total / 100).toFixed(2)} ${session.currency.toUpperCase()}</p>
        <p>Customer Email: ${session.customer_details.email}</p>
        <p>Shipping Details:<br>${shippingDetails}</p>
      `;
  
      // Send email to customer
      await sendMail(session.customer_details.email, "Order Confirmation", messageForCustomer);
  
      // Send email to shop owner
      await sendMail("designr.pros@gmail.com", "New Order Received", messageForShopOwner);
  
      console.log('Checkout session completed:', session.id);
  } else {
    console.warn(`Unhandled event type ${event.type}`);
  }

  response.json({received: true});
});


// Assuming you've already set up Express (`app`) and Firestore (`db`)

app.get('/api/dashboard/metrics', async (req, res) => {
  try {
    // Example: Fetch total sales and order count
    const ordersSnapshot = await db.collection('orders').get();
    let totalSales = 0;
    let ordersCount = ordersSnapshot.size;

    ordersSnapshot.forEach(doc => {
      const order = doc.data();
      totalSales += order.totalAmount; // Ensure your order documents have a `totalAmount` field
    });

    // Example: Fetch total customer count
    const customersCount = (await db.collection('customers').get()).size;

    res.json({
      totalSales,
      ordersCount,
      customersCount
    });
  } catch (error) {
    console.error('Failed to fetch dashboard metrics:', error);
    res.status(500).send('Internal Server Error');
  }
});

// In your Express server file

app.get('/api/orders', async (req, res) => {
  try {
    const ordersSnapshot = await db.collection('orders').orderBy('createdAt', 'desc').get();
    const orders = [];
    ordersSnapshot.forEach(doc => orders.push({ id: doc.id, ...doc.data() }));
    res.json({ orders });
  } catch (error) {
    console.error('Failed to fetch orders:', error);
    res.status(500).send('Internal Server Error');
  }
});

// In your Express server file

app.get('/api/order/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  try {
    const orderRef = db.collection('orders').doc(sessionId);
    const doc = await orderRef.get();
    if (!doc.exists) {
      console.log('No such order!');
      res.status(404).send('Not Found');
    } else {
      console.log('Order data:', doc.data());
      res.json(doc.data());
    }
  } catch (error) {
    console.error('Error getting order:', error);
    res.status(500).send('Internal Server Error');
  }
});





const PORT = process.env.PORT || 4242;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));