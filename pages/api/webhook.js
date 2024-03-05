const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// Assuming you've initialized the Firebase Admin SDK correctly (globally or within this file)
const admin = require('firebase-admin');
const serviceAccount = require('.../firebase-service-account.json');

// Initialize Firebase Admin SDK if not already initialized
if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
    });
}

const db = admin.firestore();

module.exports = async (req, res) => {
    console.log("Received webhook request:", req.method, req.url); // Log request details

    if (req.method !== 'POST') {
        console.error("Method not allowed:", req.method); // Log non-POST request error
        return res.status(405).end('Method Not Allowed');
    }

    const sig = req.headers['stripe-signature'];
    let event;

    try {
        event = stripe.webhooks.constructEvent(
            req.body,
            sig,
            process.env.STRIPE_WEBHOOK_SECRET
        );
    } catch (err) {
        console.error(`Webhook signature verification failed.`, err.message); // Log error message
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Handle the event (replace with your specific logic)
    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;

        console.log("Checkout session completed:", session.id); // Log checkout session completion

        try {
            // Perform operations based on the checkout session completion
            // (e.g., save the order to Firestore, send order confirmation emails, etc.)
            const orderRef = db.collection('orders').doc(session.id);
            await orderRef.set({
                customerEmail: session.customer_details.email,
                status: 'completed',
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                // Add other order details you need
            });

            console.log(`Order ${session.id} saved to Firestore.`); // Log order saving success
        } catch (error) {
            console.error("Error saving order to Firestore:", error.message); // Log error message
            // Handle errors appropriately (e.g., retry saving, send notifications)
        }
    } else {
        console.warn(`Unhandled event type ${event.type}`); // Log unhandled event types
    }

    // Return a response to acknowledge receipt of the event
    res.json({ received: true });
};
