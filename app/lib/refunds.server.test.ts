import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { RouterContextProvider } from "react-router";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { RefundRequestStatus, RefundStatus } from "~/db/schema";

let testDb: ReturnType<typeof createTestDb>;

vi.mock("~/db", () => ({
  get db() {
    return testDb;
  },
}));

import {
  approveRefundRequest,
  isRefundedPurchase,
  declineRefundRequest,
  markRefundIssued,
  markRefundFailed,
  buildRefundRequestApprovedEmail,
  buildRefundRequestDeclinedEmail,
  buildRefundRequestWithdrawnEmail,
  buildRefundIssuedEmail,
  buildRefundFailedEmail,
  withdrawRefundRequest,
} from "./refunds.server";
import { setCurrentUserId } from "~/lib/session";
import { action as raiseRefundRequest } from "~/routes/courses.$slug.refund";
import { getAccess } from "~/lib/access.server";

let base: ReturnType<typeof seedBaseData>;
let teamMember: typeof schema.users.$inferSelect;
let consoleLog: ReturnType<typeof vi.spyOn>;

function createRefundRequest(status = RefundRequestStatus.Open) {
  const purchase = testDb
    .insert(schema.purchases)
    .values({
      userId: base.user.id,
      courseId: base.course.id,
      amountPaid: 7900,
    })
    .returning()
    .get();

  return testDb
    .insert(schema.refundRequests)
    .values({
      purchaseId: purchase.id,
      status,
      reason: "Bought the wrong one.",
    })
    .returning()
    .get();
}

function getRefundRequest(id: number) {
  return testDb
    .select()
    .from(schema.refundRequests)
    .where(eq(schema.refundRequests.id, id))
    .get();
}

function getRefundsFor(refundRequestId: number) {
  return testDb
    .select()
    .from(schema.refunds)
    .where(eq(schema.refunds.refundRequestId, refundRequestId))
    .all();
}

function lastEmail() {
  const calls = consoleLog.mock.calls;
  return String(calls[calls.length - 1]?.[0]);
}

function expectRejected(fn: () => unknown, status: number) {
  try {
    fn();
  } catch (error) {
    expect(error).toMatchObject({ init: { status } });
    return;
  }
  throw new Error("Expected the change to be rejected");
}

async function raise() {
  const cookie = await setCurrentUserId(
    new Request("http://localhost/"),
    base.user.id
  );
  const url = new URL(`http://localhost/courses/${base.course.slug}/refund`);
  const request = new Request(url, {
    method: "POST",
    headers: { Cookie: cookie },
    body: new URLSearchParams({ reason: "Changed my mind again." }),
  });
  return raiseRefundRequest({
    request,
    url,
    pattern: "/courses/:slug/refund",
    params: { slug: base.course.slug },
    context: new RouterContextProvider(),
  });
}

function openRequestsFor(purchaseId: number) {
  return testDb
    .select()
    .from(schema.refundRequests)
    .where(eq(schema.refundRequests.purchaseId, purchaseId))
    .all()
    .filter((row) => row.status === RefundRequestStatus.Open);
}

beforeEach(() => {
  testDb = createTestDb();
  base = seedBaseData(testDb);
  teamMember = testDb
    .insert(schema.users)
    .values({
      name: "Team Member",
      email: "team@example.com",
      role: schema.UserRole.Admin,
    })
    .returning()
    .get();
  consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  consoleLog.mockRestore();
});

describe("approveRefundRequest", () => {
  it("approves an Open Refund Request and records who decided it, and when", () => {
    const request = createRefundRequest();

    approveRefundRequest(request.id, teamMember.id);

    const updated = getRefundRequest(request.id);
    expect(updated?.status).toBe(RefundRequestStatus.Approved);
    expect(updated?.resolvedByUserId).toBe(teamMember.id);
    expect(updated?.resolvedAt).toEqual(expect.any(String));
  });

  it("creates a Pending Refund for the full amount paid", () => {
    const request = createRefundRequest();

    const { refund } = approveRefundRequest(request.id, teamMember.id);

    expect(getRefundsFor(request.id)).toEqual([refund]);
    expect(refund.status).toBe(RefundStatus.Pending);
    expect(refund.amount).toBe(7900);
    expect(refund.resolvedAt).toBeNull();
  });

  it("emails the learner that their Refund Request is Approved", () => {
    const request = createRefundRequest();

    approveRefundRequest(request.id, teamMember.id);

    expect(lastEmail()).toContain("to=test@example.com");
    expect(lastEmail()).toContain("Your Refund Request is Approved");
  });

  it.each([RefundRequestStatus.Approved, RefundRequestStatus.Declined])(
    "rejects a Refund Request that is already %s, and creates no Refund",
    (status) => {
      const request = createRefundRequest(status);

      expectRejected(
        () => approveRefundRequest(request.id, teamMember.id),
        409
      );
      expect(getRefundsFor(request.id)).toEqual([]);
      expect(consoleLog).not.toHaveBeenCalled();
    }
  );

  it("rejects a Refund Request that does not exist", () => {
    expectRejected(() => approveRefundRequest(999, teamMember.id), 404);
  });
});

describe("declineRefundRequest", () => {
  it("declines an Open Refund Request with no Refund", () => {
    const request = createRefundRequest();

    declineRefundRequest(request.id, teamMember.id);

    const updated = getRefundRequest(request.id);
    expect(updated?.status).toBe(RefundRequestStatus.Declined);
    expect(updated?.resolvedByUserId).toBe(teamMember.id);
    expect(updated?.resolvedAt).toEqual(expect.any(String));
    expect(getRefundsFor(request.id)).toEqual([]);
    expect(lastEmail()).toContain("Your Refund Request is Declined");
  });

  it.each([RefundRequestStatus.Approved, RefundRequestStatus.Declined])(
    "rejects a Refund Request that is already %s",
    (status) => {
      const request = createRefundRequest(status);

      expectRejected(
        () => declineRefundRequest(request.id, teamMember.id),
        409
      );
      expect(getRefundRequest(request.id)?.status).toBe(status);
    }
  );
});

describe("withdrawRefundRequest", () => {
  it("withdraws the learner's Open Refund Request and records that they did it, and when", () => {
    const request = createRefundRequest();

    withdrawRefundRequest(request.id, base.user.id);

    const updated = getRefundRequest(request.id);
    expect(updated?.status).toBe(RefundRequestStatus.Withdrawn);
    expect(updated?.resolvedByUserId).toBe(base.user.id);
    expect(updated?.resolvedAt).toEqual(expect.any(String));
  });

  it("creates no Refund", () => {
    const request = createRefundRequest();

    withdrawRefundRequest(request.id, base.user.id);

    expect(getRefundsFor(request.id)).toEqual([]);
  });

  it("emails the learner that their Refund Request is Withdrawn", () => {
    const request = createRefundRequest();

    withdrawRefundRequest(request.id, base.user.id);

    expect(lastEmail()).toContain("to=test@example.com");
    expect(lastEmail()).toContain(
      `Your Refund Request is Withdrawn: ${base.course.title}`
    );
  });

  it.each([
    RefundRequestStatus.Approved,
    RefundRequestStatus.Declined,
    RefundRequestStatus.Withdrawn,
  ])("rejects a Refund Request that is already %s", (status) => {
    const request = createRefundRequest(status);

    expectRejected(() => withdrawRefundRequest(request.id, base.user.id), 409);
    expect(getRefundRequest(request.id)?.status).toBe(status);
    expect(getRefundsFor(request.id)).toEqual([]);
    expect(consoleLog).not.toHaveBeenCalled();
  });

  it("does not let another user withdraw it, or reveal that it exists", () => {
    const request = createRefundRequest();

    expectRejected(
      () => withdrawRefundRequest(request.id, base.instructor.id),
      404
    );
    expect(getRefundRequest(request.id)?.status).toBe(RefundRequestStatus.Open);
    expect(consoleLog).not.toHaveBeenCalled();
  });

  it("rejects a Refund Request that does not exist", () => {
    expectRejected(() => withdrawRefundRequest(999, base.user.id), 404);
  });

  describe("raising a new Refund Request on the same purchase", () => {
    it("is blocked while the Refund Request is Open", async () => {
      createRefundRequest();

      await expect(raise()).rejects.toMatchObject({ init: { status: 409 } });
    });

    it("is allowed once the Refund Request is Withdrawn", async () => {
      const request = createRefundRequest();
      withdrawRefundRequest(request.id, base.user.id);

      const response = await raise();

      expect(response).toBeInstanceOf(Response);
      expect(openRequestsFor(request.purchaseId)).toHaveLength(1);
    });
  });
});

describe("markRefundIssued and markRefundFailed", () => {
  function createPendingRefund() {
    const request = createRefundRequest();
    const { refund } = approveRefundRequest(request.id, teamMember.id);
    consoleLog.mockClear();
    return { request, refund };
  }

  it("marks a Pending Refund Issued and sets when", () => {
    const { refund } = createPendingRefund();

    const issued = markRefundIssued(refund.id);

    expect(issued.status).toBe(RefundStatus.Issued);
    expect(issued.resolvedAt).toEqual(expect.any(String));
    expect(lastEmail()).toContain("Your Refund is Issued");
  });

  it("marks a Pending Refund Failed and leaves the Refund Request Approved", () => {
    const { request, refund } = createPendingRefund();

    const failed = markRefundFailed(refund.id);

    expect(failed.status).toBe(RefundStatus.Failed);
    expect(failed.resolvedAt).toEqual(expect.any(String));
    expect(getRefundRequest(request.id)?.status).toBe(
      RefundRequestStatus.Approved
    );
    expect(lastEmail()).toContain("Your Refund has Failed");
  });

  it.each([
    ["Issued", markRefundIssued],
    ["Failed", markRefundFailed],
  ] as const)("rejects marking an Issued Refund %s", (_, mark) => {
    const { refund } = createPendingRefund();
    markRefundIssued(refund.id);
    consoleLog.mockClear();

    expectRejected(() => mark(refund.id), 409);
    expect(consoleLog).not.toHaveBeenCalled();
  });

  it.each([
    ["Issued", markRefundIssued],
    ["Failed", markRefundFailed],
  ] as const)("rejects marking a Failed Refund %s", (_, mark) => {
    const { refund } = createPendingRefund();
    markRefundFailed(refund.id);

    expectRejected(() => mark(refund.id), 409);
  });

  it("rejects a Refund that does not exist", () => {
    expectRejected(() => markRefundIssued(999), 404);
  });
});

describe("learner emails", () => {
  const input = {
    learnerName: "Liam",
    learnerEmail: "liam@example.com",
    courseTitle: "Introduction to TypeScript",
    amount: 7900,
  };
  const emails = [
    buildRefundRequestApprovedEmail(input),
    buildRefundRequestDeclinedEmail(input),
    buildRefundRequestWithdrawnEmail(input),
    buildRefundIssuedEmail(input),
    buildRefundFailedEmail(input),
  ];

  it("never uses the words the glossary says to avoid", () => {
    for (const email of emails) {
      const text = `${email.subject}\n${email.body}`;
      expect(text).not.toMatch(/reversal|chargeback|cancel/i);
      // "Pending" only ever names a Pending Refund.
      expect(text.match(/Pending(?! Refund)/g)).toBeNull();
      // "Refund" on its own never names the request.
      expect(text).not.toMatch(/\brefund\b/);
    }
  });

  it("tells a learner with a Declined Refund Request they may raise a new one", () => {
    const email = buildRefundRequestDeclinedEmail(input);
    expect(email.body).toContain("you may raise a new Refund Request");
  });

  it("tells a learner with a Withdrawn Refund Request there is no Refund, and they may raise a new one", () => {
    const email = buildRefundRequestWithdrawnEmail(input);
    expect(email.subject).toBe(
      "Your Refund Request is Withdrawn: Introduction to TypeScript"
    );
    expect(email.body).toContain("there is no Refund");
    expect(email.body).toContain(
      "you may raise a new Refund Request from the course page while you are still eligible"
    );
    // A withdrawal is never named as another outcome.
    expect(`${email.subject}\n${email.body}`).not.toMatch(
      /cancel|closed|declined/i
    );
  });

  it("tells a learner with a Failed Refund the team will be in touch, and the Refund Request is still Approved", () => {
    const email = buildRefundFailedEmail(input);
    expect(email.body).toContain("Our team will be in touch");
    expect(email.body).toContain("Your Refund Request is still Approved");
  });

  it("states the full amount paid", () => {
    expect(buildRefundRequestApprovedEmail(input).body).toContain("$79.00");
  });
});

describe("a Refunded Purchase", () => {
  function enroll() {
    testDb
      .insert(schema.enrollments)
      .values({
        userId: base.user.id,
        courseId: base.course.id,
        completedAt: new Date().toISOString(),
      })
      .run();
  }

  function enrollmentsFor(userId: number) {
    return testDb
      .select()
      .from(schema.enrollments)
      .where(eq(schema.enrollments.userId, userId))
      .all();
  }

  function createPendingRefund() {
    const request = createRefundRequest();
    const { refund } = approveRefundRequest(request.id, teamMember.id);
    return { request, refund };
  }

  async function learnerAccess() {
    const cookie = await setCurrentUserId(
      new Request("http://localhost/"),
      base.user.id
    );
    return getAccess(
      new Request("http://localhost/", { headers: { Cookie: cookie } }),
      base.course.id
    );
  }

  /** Everything the learner did in the course, which a Refund must not wipe. */
  function seedLearnerHistory() {
    const courseModule = testDb
      .insert(schema.modules)
      .values({ courseId: base.course.id, title: "Module", position: 1 })
      .returning()
      .get();
    const lesson = testDb
      .insert(schema.lessons)
      .values({ moduleId: courseModule.id, title: "Lesson", position: 1 })
      .returning()
      .get();
    const quiz = testDb
      .insert(schema.quizzes)
      .values({ lessonId: lesson.id, title: "Quiz", passingScore: 0.5 })
      .returning()
      .get();

    const userId = base.user.id;
    testDb
      .insert(schema.lessonProgress)
      .values({
        userId,
        lessonId: lesson.id,
        status: schema.LessonProgressStatus.Completed,
        completedAt: new Date().toISOString(),
      })
      .run();
    testDb
      .insert(schema.videoWatchEvents)
      .values({
        userId,
        lessonId: lesson.id,
        eventType: "pause",
        positionSeconds: 120,
      })
      .run();
    testDb
      .insert(schema.quizAttempts)
      .values({ userId, quizId: quiz.id, score: 1, passed: true })
      .run();
    testDb
      .insert(schema.comments)
      .values({ userId, lessonId: lesson.id, body: "Great lesson." })
      .run();
    testDb
      .insert(schema.courseRatings)
      .values({ userId, courseId: base.course.id, rating: 4 })
      .run();
  }

  function learnerHistoryCounts() {
    const userId = base.user.id;
    const count = (rows: unknown[]) => rows.length;
    return {
      lessonProgress: count(
        testDb
          .select()
          .from(schema.lessonProgress)
          .where(eq(schema.lessonProgress.userId, userId))
          .all()
      ),
      videoWatchEvents: count(
        testDb
          .select()
          .from(schema.videoWatchEvents)
          .where(eq(schema.videoWatchEvents.userId, userId))
          .all()
      ),
      quizAttempts: count(
        testDb
          .select()
          .from(schema.quizAttempts)
          .where(eq(schema.quizAttempts.userId, userId))
          .all()
      ),
      comments: count(
        testDb
          .select()
          .from(schema.comments)
          .where(eq(schema.comments.userId, userId))
          .all()
      ),
      courseRatings: count(
        testDb
          .select()
          .from(schema.courseRatings)
          .where(eq(schema.courseRatings.userId, userId))
          .all()
      ),
    };
  }

  it("takes the course away when the Refund is Issued", async () => {
    enroll();
    const { refund } = createPendingRefund();

    markRefundIssued(refund.id);

    expect(enrollmentsFor(base.user.id)).toEqual([]);
    const access = await learnerAccess();
    expect(access.enrolled).toBe(false);
    expect(access.canViewContent).toBe(false);
  });

  it("leaves the learner's progress, watch history, quiz attempts, comments and rating alone", () => {
    enroll();
    seedLearnerHistory();
    const { refund } = createPendingRefund();

    markRefundIssued(refund.id);

    expect(learnerHistoryCounts()).toEqual({
      lessonProgress: 1,
      videoWatchEvents: 1,
      quizAttempts: 1,
      comments: 1,
      courseRatings: 1,
    });
  });

  it("leaves other learners' access alone", () => {
    enroll();
    testDb
      .insert(schema.enrollments)
      .values({ userId: teamMember.id, courseId: base.course.id })
      .run();
    const { refund } = createPendingRefund();

    markRefundIssued(refund.id);

    expect(enrollmentsFor(teamMember.id)).toHaveLength(1);
  });

  it("keeps the course while the Refund Request is Approved and the Refund Pending", async () => {
    enroll();
    createPendingRefund();

    expect(enrollmentsFor(base.user.id)).toHaveLength(1);
    expect((await learnerAccess()).canViewContent).toBe(true);
  });

  it("keeps the course when the Refund has Failed", async () => {
    enroll();
    const { refund } = createPendingRefund();

    markRefundFailed(refund.id);

    expect(enrollmentsFor(base.user.id)).toHaveLength(1);
    expect((await learnerAccess()).canViewContent).toBe(true);
  });

  it("is only a purchase whose Refund is Issued", () => {
    const { request, refund } = createPendingRefund();
    expect(isRefundedPurchase(request.purchaseId)).toBe(false);

    markRefundIssued(refund.id);

    expect(isRefundedPurchase(request.purchaseId)).toBe(true);
  });

  it("does not take a team buyer's own enrollment when a team purchase is refunded", () => {
    enroll();
    const team = testDb.insert(schema.teams).values({}).returning().get();
    const { request, refund } = createPendingRefund();
    testDb
      .insert(schema.coupons)
      .values({
        teamId: team.id,
        courseId: base.course.id,
        code: "unclaimed-seat",
        purchaseId: request.purchaseId,
      })
      .run();

    markRefundIssued(refund.id);

    expect(enrollmentsFor(base.user.id)).toHaveLength(1);
    expect(isRefundedPurchase(request.purchaseId)).toBe(true);
  });
});

describe("raising a new Refund Request after an earlier one was decided", () => {
  function approved() {
    const request = createRefundRequest();
    const { refund } = approveRefundRequest(request.id, teamMember.id);
    return { request, refund };
  }

  it("is rejected on a Refunded Purchase", async () => {
    const { request, refund } = approved();
    markRefundIssued(refund.id);

    await expect(raise()).rejects.toMatchObject({
      data: "This purchase has already been refunded.",
      init: { status: 409 },
    });
    expect(openRequestsFor(request.purchaseId)).toEqual([]);
  });

  it("is rejected while the Refund Request is Approved and the Refund Pending", async () => {
    const { request } = approved();

    await expect(raise()).rejects.toMatchObject({
      data: "Your Refund Request for this purchase is already Approved.",
      init: { status: 409 },
    });
    expect(openRequestsFor(request.purchaseId)).toEqual([]);
  });

  it("is rejected when the Refund has Failed, because the Refund Request is still Approved", async () => {
    const { request, refund } = approved();
    markRefundFailed(refund.id);

    await expect(raise()).rejects.toMatchObject({
      data: "Your Refund Request for this purchase is already Approved.",
      init: { status: 409 },
    });
    expect(openRequestsFor(request.purchaseId)).toEqual([]);
  });

  it("is allowed once the Refund Request is Declined", async () => {
    const request = createRefundRequest();
    declineRefundRequest(request.id, teamMember.id);

    const response = await raise();

    expect(response).toBeInstanceOf(Response);
    expect(openRequestsFor(request.purchaseId)).toHaveLength(1);
  });

  it("is allowed once the Refund Request is Withdrawn", async () => {
    const request = createRefundRequest();
    withdrawRefundRequest(request.id, base.user.id);

    const response = await raise();

    expect(response).toBeInstanceOf(Response);
    expect(openRequestsFor(request.purchaseId)).toHaveLength(1);
  });
});
