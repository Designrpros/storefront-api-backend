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
  const accessToken = await oAuth2Client.getAccessToken(); // Ensure you get a fresh access token

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD, // Ensure this is updated
    },
  });
  

  const mailOptions = {
    from: `Høl i CVen <${process.env.GMAIL_USER}>`,
    to: email,
    subject: subject,
    html: `<p>${message}</p>`, // Using HTML for email body
  };

  try {
    const result = await transporter.sendMail(mailOptions);
    console.log('Email sent:', result);
  } catch (error) {
    console.error('Failed to send email:', error);
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


app.post('/webhook', express.raw({ type: 'application/json' }), async (request, response) => {
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
    const fullSession = await stripe.checkout.sessions.retrieve(session.id, {
      expand: ['line_items.data.price.product']
    });

    const productsPurchased = fullSession.line_items.data.map(item => ({
      name: item.price.product.name,
      quantity: item.quantity,
      unitPrice: item.price.unit_amount,
      totalPrice: item.amount_total
    }));

    const shippingDetails = session.shipping ? {
      name: session.shipping.name,
      address: session.shipping.address
    } : "No shipping details available";

    let shippingDetailsHtml = "Fraktinformasjon ikke tilgjengelig";
    if (shippingDetails.name) {
      shippingDetailsHtml = `
        <p>Leveringsdetaljer:<br>${shippingDetails.name}, ${shippingDetails.address.line1}, ${shippingDetails.address.city}</p>
      `;
    }

    const productDetailsHtml = productsPurchased.map(product => 
      `<li>${product.name} - Antall: ${product.quantity} - Pris: ${(product.unitPrice / 100).toFixed(2)} NOK</li>`
    ).join('');

    const messageForCustomer = constructEmailMessage(session, productDetailsHtml, shippingDetailsHtml, true);
    await sendMail(session.customer_details.email, "Ordrebekreftelse", messageForCustomer)
      .then(() => console.log('Email sent to customer.'))
      .catch(error => console.error('Failed to send email to customer', error));

    const messageForShopOwner = constructEmailMessage(session, productDetailsHtml, shippingDetailsHtml, false);
    await sendMail(process.env.SHOP_OWNER_EMAIL, "Ny ordre mottatt", messageForShopOwner)
      .then(() => console.log('Email sent to shop owner.'))
      .catch(error => console.error('Failed to send email to shop owner', error));

    console.log('Checkout session completed:', session.id);
  } else {
    console.warn(`Unhandled event type ${event.type}`);
  }

  response.json({ received: true });
});


function constructEmailMessage(session, productDetailsHtml, shippingDetailsHtml, isCustomer) {
  const heading = isCustomer ? "Ordrebekreftelse" : "Ny ordre mottatt";
  const imageUrl = "https://h-l-i-c-ven.vercel.app/static/media/H%C3%98L_I_CVEN_GR%C3%98NN.85f3db364c841eeec633.png";
  const emailGreeting = isCustomer ? "<p>Takk for din bestilling!</p>" : "<p>En ny ordre har blitt plassert.</p>";
  // Apply word-break style to the order number to ensure it wraps on small screens
  const orderNumberDisplay = `<p style="word-break: break-all;">Ordrenummer: ${session.id}</p>`;

  return `
    <table width="100%" border="0" cellspacing="0" cellpadding="0" style="font-family: Arial, sans-serif;">
      <tr>
        <td align="center">
          <table width="100%" border="0" cellspacing="0" cellpadding="20" bgcolor="#f6f6f6" style="max-width: 600px;">
            <tr bgcolor="#9dd2ac">
              <td align="center" style="padding-bottom: 0; padding-top: 0;">
                <img src="${imageUrl}" alt="Logo" style="width: 120px; height: auto; display: block; margin: auto;">
              </td>
            </tr>
            <tr bgcolor="#9dd2ac">
              <td align="center" style="color: white; font-size: 24px; padding-top: 10px; padding-bottom: 10px;">${heading}</td>
            </tr>
            <tr>
              <td align="left" style="color: #333;">
                ${emailGreeting}
                ${orderNumberDisplay}
                <p>Produkter:<br><ul style="list-style-type: none; padding: 0;">${productDetailsHtml}</ul></p>
                <p>Totalbeløp: ${(session.amount_total / 100).toFixed(2)} ${session.currency.toUpperCase()}</p>
                ${shippingDetailsHtml}
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  `;
}



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


app.get('/api/order/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['line_items.data.price.product'],
    });

    // Assuming you want to return similar data structure as you have in your webhook
    const productsPurchased = session.line_items.data.map(item => ({
      name: item.price.product.name,
      quantity: item.quantity,
      unitPrice: item.price.unit_amount,
      totalPrice: item.amount_total
    }));

    const shippingDetails = session.shipping ? {
      name: session.shipping.name,
      address: session.shipping.address
    } : null;

    const orderDetails = {
      id: session.id,
      totalAmount: session.amount_total,
      currency: session.currency,
      productsPurchased,
      shippingDetails,
    };

    res.json(orderDetails);
  } catch (error) {
    console.error('Failed to fetch order details:', error);
    res.status(500).send('Internal Server Error');
  }
});


app.post('/api/send-confirmation', async (req, res) => {
    const { orderId } = req.body;

    try {
        const orderDoc = await db.collection('orders').doc(orderId).get();
        if (!orderDoc.exists) {
            return res.status(404).send('Order not found');
        }

        const order = orderDoc.data();
        // Email to the customer
        const customerEmailBody = constructEmailBody(order);
        await sendMail(order.email, 'Din kaffe er på vei!', customerEmailBody);

        // Email to the shop owner
        const shopOwnerEmailBody = constructShopOwnerEmailBody(order);
        await sendMail("designr.pros@gmail.com", "Forsendelsesbekreftelse Sendt", shopOwnerEmailBody);

        res.send({ message: 'Shipment confirmation email sent successfully' });
    } catch (error) {
        console.error('Failed to send confirmation email:', error);
        res.status(500).send('Failed to send confirmation email');
    }
});



function constructEmailBody(order) {
  const productsHtml = order.productsPurchased.map(product =>
    `<li>${product.name} - Antall: ${product.quantity} - Pris: ${(product.unitPrice / 100).toFixed(2)} NOK</li>`
  ).join('');

  let shippingDetailsHtml = "Fraktinformasjon ikke tilgjengelig";
  if (order.shippingDetails && order.shippingDetails.address) {
    shippingDetailsHtml = `
      <p><strong>Navn:</strong> ${order.shippingDetails.name}</p>
      <p><strong>Adresse:</strong> ${order.shippingDetails.address.line1}, ${order.shippingDetails.address.postal_code} ${order.shippingDetails.address.city}, ${order.shippingDetails.address.country}</p>
    `;
  }

  const imageUrl = "https://h-l-i-c-ven.vercel.app/static/media/H%C3%98L_I_CVEN_GR%C3%98NN.85f3db364c841eeec633.png";

  return `
    <table width="100%" border="0" cellspacing="0" cellpadding="0" style="font-family: Arial, sans-serif; max-width: 600px; margin: auto;">
      <tr>
        <td align="center" bgcolor="#9dd2ac" style="padding: 20px;">
          <img src="${imageUrl}" alt="Logo" style="width: 100px; height: auto; margin-bottom: 20px;">
          <h1 style="color: white; font-size: 24px; margin: 0;">Din kaffe er på vei!</h1>
        </td>
      </tr>
      <tr>
        <td style="padding: 20px; background-color: #f6f6f6;">
          <p>Vi har sendt din bestilling, og den er nå på vei til deg.</p>
          <h2>Detaljer om bestillingen:</h2>
          <ul style="list-style-type: none; padding: 0;">
            ${productsHtml}
          </ul>
          <p><strong>Totalbeløp:</strong> ${(order.totalAmount / 100).toFixed(2)} NOK</p>
          <h2>Fraktinformasjon:</h2>
          ${shippingDetailsHtml}
          <p>Takk for at du valgte oss. Vi håper du vil nyte kaffen!</p>
        </td>
      </tr>
    </table>
  `;
}

function constructShopOwnerEmailBody(order) {
  const productsHtml = order.productsPurchased.map(product =>
    `<li>${product.name} - Antall: ${product.quantity} - Pris: ${(product.unitPrice / 100).toFixed(2)} NOK</li>`
  ).join('');

  const imageUrl = "https://h-l-i-c-ven.vercel.app/static/media/H%C3%98L_I_CVEN_GR%C3%98NN.85f3db364c841eeec633.png";

  return `
    <table width="100%" border="0" cellspacing="0" cellpadding="0" style="font-family: Arial, sans-serif; max-width: 600px; margin: auto;">
      <tr>
        <td align="center" bgcolor="#9dd2ac" style="padding: 20px;">
          <img src="${imageUrl}" alt="Logo" style="width: 100px; height: auto; margin-bottom: 20px;">
          <h1 style="color: white; font-size: 24px; margin: 0;">Ny ordre Sendt!</h1>
        </td>
      </tr>
      <tr>
        <td style="padding: 20px; background-color: #f6f6f6;">
          <p>En ordre har blitt Sendt.
          <h2>Detaljer om bestillingen:</h2>
          <ul style="list-style-type: none; padding: 0;">
            ${productsHtml}
          </ul>
          <p><strong>Totalbeløp:</strong> ${(order.totalAmount / 100).toFixed(2)} NOK</p>
          <p><strong>Kundens e-post:</strong> <a href="mailto:${order.email}" style="color: #3498db;">${order.email}</a></p>
        </td>
      </tr>
    </table>
  `;
}


const PORT = process.env.PORT || 4242;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));