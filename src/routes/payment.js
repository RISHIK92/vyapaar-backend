// import { Router } from "express";
// const router = Router();
// import Razorpay from "razorpay";
// import { PrismaClient } from "@prisma/client";
// const prisma = new PrismaClient();
// import { createHmac } from "crypto";

// const razorpay = new Razorpay({
//   key_id: process.env.RAZORPAY_KEY_ID,
//   key_secret: process.env.RAZORPAY_KEY_SECRET,
// });

// router.post("/create-order", async (req, res) => {
//   try {
//     const { amount, currency, listingId, pricingOption } = req.body;

//     const pricingOptions = {
//       Free: 0,
//       TopPage: 850, // ₹8.50 in paise
//       TopPageAd: 15000, // ₹150.00 in paise
//     };

//     if (!pricingOptions.hasOwnProperty(pricingOption)) {
//       return res.status(400).json({ error: "Invalid pricing option" });
//     }

//     if (pricingOption !== "Free" && amount !== pricingOptions[pricingOption]) {
//       return res
//         .status(400)
//         .json({ error: "Amount doesn't match pricing option" });
//     }

//     // For free listings, just return a dummy order
//     if (pricingOption === "Free") {
//       return res.json({
//         order: {
//           id: "free_listing",
//           amount: 0,
//           currency: "INR",
//           status: "created",
//         },
//       });
//     }

//     const options = {
//       amount: amount.toString(),
//       currency: currency || "INR",
//       receipt: `listing_${listingId}`,
//       payment_capture: 1,
//       notes: {
//         listingId,
//         pricingOption,
//       },
//     };

//     const order = await razorpay.orders.create(options);
//     res.json({ order });
//   } catch (error) {
//     console.error("Error creating order:", error);
//     res.status(500).json({ error: "Failed to create payment order" });
//   }
// });

// // Verify payment
// router.post("/verify", async (req, res) => {
//   try {
//     const {
//       razorpay_payment_id,
//       razorpay_order_id,
//       razorpay_signature,
//       listingId,
//       pricingOption,
//     } = req.body;

//     // For free listings, just mark as paid
//     if (pricingOption === "Free") {
//       await updateListingAfterPayment(listingId, "Free", "free_listing");
//       return res.json({ success: true });
//     }

//     // Verify the payment signature
//     const generatedSignature = createHmac(
//       "sha256",
//       process.env.RAZORPAY_KEY_SECRET
//     )
//       .update(`${razorpay_order_id}|${razorpay_payment_id}`)
//       .digest("hex");

//     if (generatedSignature !== razorpay_signature) {
//       return res.status(400).json({ error: "Invalid payment signature" });
//     }

//     // Update listing and create promotion
//     await updateListingAfterPayment(
//       listingId,
//       pricingOption,
//       razorpay_payment_id
//     );

//     res.json({ success: true });
//   } catch (error) {
//     console.error("Payment verification error:", error);
//     res.status(500).json({ error: "Payment verification failed" });
//   }
// });

// // Webhook for payment events
// router.post("/webhook", async (req, res) => {
//   const body = req.body;
//   const signature = req.headers["x-razorpay-signature"];

//   // Verify webhook signature
//   const expectedSignature = createHmac(
//     "sha256",
//     process.env.RAZORPAY_WEBHOOK_SECRET
//   )
//     .update(JSON.stringify(body))
//     .digest("hex");

//   if (expectedSignature !== signature) {
//     return res.status(400).json({ error: "Invalid webhook signature" });
//   }

//   const event = body.event;

//   try {
//     if (event === "payment.captured") {
//       const payment = body.payload.payment.entity;
//       const listingId = payment.notes?.listingId;
//       const pricingOption = payment.notes?.pricingOption;

//       if (listingId && pricingOption) {
//         await updateListingAfterPayment(listingId, pricingOption, payment.id);
//       }
//     }

//     res.json({ received: true });
//   } catch (error) {
//     console.error("Webhook processing error:", error);
//     res.status(500).json({ error: "Webhook processing failed" });
//   }
// });

// async function updateListingAfterPayment(listingId, pricingOption, paymentId) {
//   // Start transaction
//   return await prisma.$transaction(async (prisma) => {
//     // Update listing status and tier
//     const listing = await prisma.listing.update({
//       where: { id: listingId },
//       data: {
//         status: "APPROVED",
//         listingType: pricingOption === "TopPageAd" ? "PREMIUM" : "FREE",
//       },
//     });

//     // For paid options, create a promotion record
//     if (pricingOption !== "Free") {
//       const durationMap = {
//         TopPage: "SEVEN_DAYS",
//         TopPageAd: "THIRTY_DAYS",
//       };

//       await prisma.promotion.create({
//         data: {
//           listingId,
//           price: pricingOption === "TopPage" ? 8.5 : 150,
//           startDate: new Date(),
//           endDate: new Date(
//             Date.now() +
//               (pricingOption === "TopPage" ? 7 * 86400000 : 30 * 86400000)
//           ),
//           duration: durationMap[pricingOption],
//           isActive: true,
//         },
//       });
//     }

//     // Create payment record
//     await prisma.payment.create({
//       data: {
//         listingId,
//         amount: pricingOption === "TopPage" ? 8.5 : 150,
//         currency: "INR",
//         paymentMethod: "RAZORPAY",
//         transactionId: paymentId,
//         status: "COMPLETED",
//       },
//     });

//     return listing;
//   });
// }

// export default router;
import { Router } from "express";
const router = Router();
import Razorpay from "razorpay";
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
import { createHmac } from "crypto";

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

router.post("/create-order", async (req, res) => {
  try {
    const { amount, currency, listingId, pricingOption, subscriptionId } =
      req.body;

    const pricingOptions = {
      FREE: 0,
      PREMIUM: 850,
      PREMIUM_PLUS: 15000,
    };

    if (!Object.keys(pricingOptions).includes(pricingOption)) {
      return res.status(400).json({ error: "Invalid pricing option" });
    }

    if (pricingOption !== "FREE" && amount !== pricingOptions[pricingOption]) {
      return res
        .status(400)
        .json({ error: "Amount doesn't match pricing option" });
    }

    if (pricingOption === "FREE") {
      await updateListingAfterPayment(listingId, "FREE", "free_listing");
      return res.json({
        order: {
          id: "free_listing",
          amount: 0,
          currency: "INR",
          status: "created",
        },
        success: true,
      });
    }

    // For paid plans
    const options = {
      amount: amount.toString(),
      currency: currency || "INR",
      receipt: `listing_${listingId}`,
      payment_capture: 1,
      notes: {
        listingId,
        pricingOption,
        subscriptionId,
      },
    };

    const order = await razorpay.orders.create(options);
    res.json({ order });
  } catch (error) {
    console.error("Error creating order:", error);
    res.status(500).json({ error: "Failed to create payment order" });
  }
});

router.post("/verify", async (req, res) => {
  try {
    const {
      razorpay_payment_id,
      razorpay_order_id,
      razorpay_signature,
      listingId,
      pricingOption,
      subscriptionId,
    } = req.body;

    if (pricingOption === "FREE") {
      return res.json({ success: true });
    }

    // Verify payment signature
    const generatedSignature = createHmac(
      "sha256",
      process.env.RAZORPAY_KEY_SECRET
    )
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");

    if (generatedSignature !== razorpay_signature) {
      return res.status(400).json({ error: "Invalid payment signature" });
    }

    // Update listing and create subscription
    await prisma.$transaction(async (prisma) => {
      // Get subscription plan
      const plan = await prisma.subscriptionPlan.findFirst({
        where: { tierType: pricingOption },
      });

      if (!plan) {
        throw new Error("Subscription plan not found");
      }

      // Update listing with subscription
      await prisma.listing.update({
        where: { id: listingId },
        data: {
          status: "PENDING_APPROVAL",
          listingTier: pricingOption,
          expiresAt: new Date(Date.now() + plan.durationDays * 86400000),
          isBannerEnabled: plan.promotionDays > 0,
          subscriptionId: plan.id,
        },
      });

      // Create promotion if applicable
      if (plan.promotionDays > 0) {
        await prisma.promotion.create({
          data: {
            listingId,
            price: 0, // Included in subscription
            startDate: new Date(),
            endDate: new Date(Date.now() + plan.promotionDays * 86400000),
            durationDays: plan.promotionDays,
            isActive: true,
          },
        });
      }

      // Create payment record
      await prisma.payment.create({
        data: {
          listingId,
          amount: plan.price,
          currency: "INR",
          paymentMethod: "RAZORPAY",
          transactionId: razorpay_payment_id,
          status: "COMPLETED",
        },
      });
    });

    res.json({ success: true });
  } catch (error) {
    console.error("Payment verification error:", error);
    res
      .status(500)
      .json({ error: error.message || "Payment verification failed" });
  }
});

async function updateListingAfterPayment(listingId, pricingOption, paymentId) {
  return await prisma.$transaction(async (prisma) => {
    // Update listing status to pending approval
    const listing = await prisma.listing.update({
      where: { id: listingId },
      data: {
        status: "PENDING_APPROVAL",
        listingType: pricingOption === "TopPageAd" ? "PREMIUM" : "FREE",
      },
    });

    // Create admin approval record
    await prisma.adminApproval.create({
      data: {
        listingId,
        adminId: "1", // or get an actual admin ID
        status: "PENDING_APPROVAL",
      },
    });

    if (pricingOption !== "Free") {
      const durationMap = {
        TopPage: "SEVEN_DAYS",
        TopPageAd: "THIRTY_DAYS",
      };

      await prisma.promotion.create({
        data: {
          listingId,
          price: pricingOption === "TopPage" ? 8.5 : 150,
          startDate: new Date(),
          endDate: new Date(
            Date.now() +
              (pricingOption === "TopPage" ? 7 * 86400000 : 30 * 86400000)
          ),
          duration: durationMap[pricingOption],
          isActive: true,
        },
      });
    }

    await prisma.payment.create({
      data: {
        listingId,
        amount: pricingOption === "TopPage" ? 8.5 : 150,
        currency: "INR",
        paymentMethod: "RAZORPAY",
        transactionId: paymentId,
        status: "COMPLETED",
      },
    });

    return listing;
  });
}

export default router;
