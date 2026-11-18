import { data } from "react-router";
import { and, eq } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import type { RunResult } from "better-sqlite3";
import { db } from "~/db";
import type * as schema from "~/db/schema";
import {
  coupons,
  courses,
  enrollments,
  purchases,
  refundRequests,
  refunds,
  users,
  RefundRequestStatus,
  RefundStatus,
} from "~/db/schema";
import { formatPrice } from "~/lib/utils";

// ─── Deciding Refund Requests and settling Refunds ───
// The team decides an Open Refund Request (approve or decline). Approving it
// creates a Pending Refund for the full amount paid, which is then confirmed
// as Issued or Failed. Before the team decides, the Student may withdraw
// their Open Refund Request instead. Each change emails the Student.
//
// No team screen calls the team's decisions yet. Each change throws a
// response when it is not allowed, so the action that calls it has one
// success path.
//
// Uses positional parameters (project convention).

// The app's database or a transaction on it — anything that can write
// synchronously. The seed passes its own connection.
type Writer = BaseSQLiteDatabase<"sync", RunResult, typeof schema>;

type StudentEmail = { to: string; subject: string; body: string };

type EmailInput = {
  studentName: string;
  studentEmail: string;
  courseTitle: string;
  amount: number;
};

const SIGN_OFF = "— The Cadence team";

export function buildRefundRequestApprovedEmail(
  input: EmailInput
): StudentEmail {
  return {
    to: input.studentEmail,
    subject: `Your Refund Request is Approved: ${input.courseTitle}`,
    body: [
      `Hi ${input.studentName},`,
      "",
      `We have approved your Refund Request for "${input.courseTitle}".`,
      `You now have a Pending Refund of ${formatPrice(input.amount)}, the full amount you paid. It goes back to the card you paid with.`,
      "",
      "You do not need to do anything else — we will email you again once your Refund is Issued.",
      "",
      SIGN_OFF,
    ].join("\n"),
  };
}

export function buildRefundRequestDeclinedEmail(
  input: EmailInput
): StudentEmail {
  return {
    to: input.studentEmail,
    subject: `Your Refund Request is Declined: ${input.courseTitle}`,
    body: [
      `Hi ${input.studentName},`,
      "",
      `We have declined your Refund Request for "${input.courseTitle}", so there is no Refund.`,
      "",
      "If something has changed, you may raise a new Refund Request from the course page.",
      "",
      SIGN_OFF,
    ].join("\n"),
  };
}

export function buildRefundRequestWithdrawnEmail(
  input: EmailInput
): StudentEmail {
  return {
    to: input.studentEmail,
    subject: `Your Refund Request is Withdrawn: ${input.courseTitle}`,
    body: [
      `Hi ${input.studentName},`,
      "",
      `You have withdrawn your Refund Request for "${input.courseTitle}", so there is no Refund. You still have the course.`,
      "",
      "If you change your mind, you may raise a new Refund Request from the course page while you are still eligible.",
      "",
      SIGN_OFF,
    ].join("\n"),
  };
}

export function buildRefundIssuedEmail(input: EmailInput): StudentEmail {
  return {
    to: input.studentEmail,
    subject: `Your Refund is Issued: ${input.courseTitle}`,
    body: [
      `Hi ${input.studentName},`,
      "",
      `Your Refund of ${formatPrice(input.amount)} for "${input.courseTitle}" is Issued. We have sent the money back to the card you paid with.`,
      "",
      SIGN_OFF,
    ].join("\n"),
  };
}

export function buildRefundFailedEmail(input: EmailInput): StudentEmail {
  return {
    to: input.studentEmail,
    subject: `Your Refund has Failed: ${input.courseTitle}`,
    body: [
      `Hi ${input.studentName},`,
      "",
      `We could not send your Refund of ${formatPrice(input.amount)} for "${input.courseTitle}", so your Refund has Failed.`,
      "Your Refund Request is still Approved — that decision has not changed.",
      "",
      "Our team will be in touch to sort it out. You do not need to raise a new Refund Request.",
      "",
      SIGN_OFF,
    ].join("\n"),
  };
}

/**
 * There is no mail transport wired up yet, so the built message goes to the
 * server log — the same as the Refund Request confirmation.
 */
function sendStudentEmail(email: StudentEmail) {
  console.log(`[email] to=${email.to} subject=${email.subject}\n${email.body}`);
}

function getRefundRequestWithStudent(refundRequestId: number) {
  return db
    .select({
      refundRequest: refundRequests,
      amountPaid: purchases.amountPaid,
      studentId: users.id,
      studentName: users.name,
      studentEmail: users.email,
      courseTitle: courses.title,
    })
    .from(refundRequests)
    .innerJoin(purchases, eq(refundRequests.purchaseId, purchases.id))
    .innerJoin(users, eq(purchases.userId, users.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(eq(refundRequests.id, refundRequestId))
    .get();
}

function getRefundWithStudent(refundId: number) {
  return db
    .select({
      refund: refunds,
      purchase: purchases,
      studentName: users.name,
      studentEmail: users.email,
      courseTitle: courses.title,
    })
    .from(refunds)
    .innerJoin(refundRequests, eq(refunds.refundRequestId, refundRequests.id))
    .innerJoin(purchases, eq(refundRequests.purchaseId, purchases.id))
    .innerJoin(users, eq(purchases.userId, users.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(eq(refunds.id, refundId))
    .get();
}

function requireOpenRefundRequest(refundRequestId: number) {
  const found = getRefundRequestWithStudent(refundRequestId);

  if (!found) {
    throw data("Refund Request not found.", { status: 404 });
  }

  if (found.refundRequest.status !== RefundRequestStatus.Open) {
    throw data("Only an Open Refund Request can be approved or declined.", {
      status: 409,
    });
  }

  return found;
}

function requirePendingRefund(refundId: number) {
  const found = getRefundWithStudent(refundId);

  if (!found) {
    throw data("Refund not found.", { status: 404 });
  }

  if (found.refund.status !== RefundStatus.Pending) {
    throw data("Only a Pending Refund can be marked Issued or Failed.", {
      status: 409,
    });
  }

  return found;
}

/**
 * Approves an Open Refund Request and, in the same transaction, creates a
 * Pending Refund for the full amount paid. A Refund is never partial.
 */
export function approveRefundRequest(
  refundRequestId: number,
  resolvedByUserId: number
) {
  const found = requireOpenRefundRequest(refundRequestId);
  const resolvedAt = new Date().toISOString();

  const result = db.transaction((tx) => {
    const refundRequest = tx
      .update(refundRequests)
      .set({
        status: RefundRequestStatus.Approved,
        resolvedAt,
        resolvedByUserId,
      })
      .where(eq(refundRequests.id, refundRequestId))
      .returning()
      .get();

    const refund = tx
      .insert(refunds)
      .values({
        refundRequestId,
        amount: found.amountPaid,
        status: RefundStatus.Pending,
      })
      .returning()
      .get();

    return { refundRequest, refund };
  });

  sendStudentEmail(
    buildRefundRequestApprovedEmail({
      studentName: found.studentName,
      studentEmail: found.studentEmail,
      courseTitle: found.courseTitle,
      amount: result.refund.amount,
    })
  );

  return result;
}

/** Declines an Open Refund Request. A declined Refund Request has no Refund. */
export function declineRefundRequest(
  refundRequestId: number,
  resolvedByUserId: number
) {
  const found = requireOpenRefundRequest(refundRequestId);

  const refundRequest = db
    .update(refundRequests)
    .set({
      status: RefundRequestStatus.Declined,
      resolvedAt: new Date().toISOString(),
      resolvedByUserId,
    })
    .where(eq(refundRequests.id, refundRequestId))
    .returning()
    .get();

  sendStudentEmail(
    buildRefundRequestDeclinedEmail({
      studentName: found.studentName,
      studentEmail: found.studentEmail,
      courseTitle: found.courseTitle,
      amount: found.amountPaid,
    })
  );

  return refundRequest;
}

/**
 * The Student takes back their own Open Refund Request before the team has
 * decided it. A Withdrawn Refund Request has no Refund, and the Student may
 * raise a new Refund Request afterwards.
 *
 * Someone else's Refund Request is reported as not found, so its existence
 * is not revealed.
 */
export function withdrawRefundRequest(refundRequestId: number, userId: number) {
  const found = getRefundRequestWithStudent(refundRequestId);

  if (!found || found.studentId !== userId) {
    throw data("Refund Request not found.", { status: 404 });
  }

  if (found.refundRequest.status !== RefundRequestStatus.Open) {
    throw data("Only an Open Refund Request can be withdrawn.", {
      status: 409,
    });
  }

  const refundRequest = db
    .update(refundRequests)
    .set({
      status: RefundRequestStatus.Withdrawn,
      resolvedAt: new Date().toISOString(),
      resolvedByUserId: userId,
    })
    .where(eq(refundRequests.id, refundRequestId))
    .returning()
    .get();

  sendStudentEmail(
    buildRefundRequestWithdrawnEmail({
      studentName: found.studentName,
      studentEmail: found.studentEmail,
      courseTitle: found.courseTitle,
      amount: found.amountPaid,
    })
  );

  return refundRequest;
}

function settlePendingRefund(
  refundId: number,
  status: RefundStatus.Issued | RefundStatus.Failed
) {
  const found = requirePendingRefund(refundId);

  const refund = db.transaction((tx) => {
    const settled = tx
      .update(refunds)
      .set({ status, resolvedAt: new Date().toISOString() })
      .where(eq(refunds.id, refundId))
      .returning()
      .get();

    // Only an Issued Refund makes a Refunded Purchase. A Pending or Failed
    // Refund leaves the Student with the course.
    if (status === RefundStatus.Issued) {
      removeCourseAccess(tx, found.purchase);
    }

    return settled;
  });

  const buildEmail =
    status === RefundStatus.Issued
      ? buildRefundIssuedEmail
      : buildRefundFailedEmail;

  sendStudentEmail(
    buildEmail({
      studentName: found.studentName,
      studentEmail: found.studentEmail,
      courseTitle: found.courseTitle,
      amount: found.refund.amount,
    })
  );

  return refund;
}

/**
 * Confirms the money for a Pending Refund has been sent. The purchase is now
 * a Refunded Purchase, so the Student loses the course in the same
 * transaction.
 */
export function markRefundIssued(refundId: number) {
  return settlePendingRefund(refundId, RefundStatus.Issued);
}

/**
 * Records that the money for a Pending Refund couldn't be sent. The Refund
 * Request stays Approved, because the decision hasn't changed, and the
 * Student keeps the course.
 */
export function markRefundFailed(refundId: number) {
  return settlePendingRefund(refundId, RefundStatus.Failed);
}

// ─── Refunded Purchases ───

/**
 * Takes the course away from the Student on a Refunded Purchase.
 *
 * Access to a course is the Student's enrollment row, so that row goes. Nothing
 * references enrollments and no foreign key cascades, so the Student's lesson
 * progress, video watch events, quiz attempts, comments and rating — all keyed
 * on user and lesson or course, not on the enrollment — stay where they are.
 *
 * A team purchase enrolls nobody: its seats are coupons. Its buyer keeps any
 * enrollment they hold from their own purchase, and its unclaimed seats are
 * closed by isRefundedPurchase at redemption. (A team purchase with a claimed
 * seat cannot have a Refund Request raised on it.)
 */
export function removeCourseAccess(
  writer: Writer,
  purchase: { id: number; userId: number; courseId: number }
) {
  const isTeamPurchase = writer
    .select({ id: coupons.id })
    .from(coupons)
    .where(eq(coupons.purchaseId, purchase.id))
    .get();

  if (isTeamPurchase) return;

  writer
    .delete(enrollments)
    .where(
      and(
        eq(enrollments.userId, purchase.userId),
        eq(enrollments.courseId, purchase.courseId)
      )
    )
    .run();
}

function getRefundRequestOutcomes(purchaseId: number) {
  return db
    .select({
      requestStatus: refundRequests.status,
      refundStatus: refunds.status,
    })
    .from(refundRequests)
    .leftJoin(refunds, eq(refunds.refundRequestId, refundRequests.id))
    .where(eq(refundRequests.purchaseId, purchaseId))
    .all();
}

/** A purchase whose Refund has been Issued. */
export function isRefundedPurchase(purchaseId: number) {
  return getRefundRequestOutcomes(purchaseId).some(
    (row) => row.refundStatus === RefundStatus.Issued
  );
}

/**
 * Why the purchase's earlier Refund Requests stop the Student raising a new
 * one, in the glossary's words — or null if they don't. The course page and
 * the refund action both ask this, so they cannot disagree about it. The
 * window, watch-time and team-seat checks are separate.
 *
 * - A Refunded Purchase can never have another Refund Request.
 * - An Approved Refund Request stands whatever its Refund's status: a Pending
 *   Refund is on its way, and the Failed Refund email tells the Student they
 *   need not raise a new one.
 * - Only one Refund Request can be Open at once.
 * - Declined and Withdrawn Refund Requests don't stand in the way.
 */
export function getRefundRequestBlocker(purchaseId: number): string | null {
  const outcomes = getRefundRequestOutcomes(purchaseId);

  if (outcomes.some((row) => row.refundStatus === RefundStatus.Issued)) {
    return "This purchase has already been refunded.";
  }

  if (
    outcomes.some((row) => row.requestStatus === RefundRequestStatus.Approved)
  ) {
    return "Your Refund Request for this purchase is already Approved.";
  }

  if (outcomes.some((row) => row.requestStatus === RefundRequestStatus.Open)) {
    return "You already have an Open Refund Request on this purchase.";
  }

  return null;
}
