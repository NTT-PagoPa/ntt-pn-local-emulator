/* eslint-disable functional/immutable-data */

import * as t from 'io-ts';
import { pipe } from 'fp-ts/function';
import * as O from 'fp-ts/Option';
import * as E from 'fp-ts/Either';
import * as RA from 'fp-ts/ReadonlyArray';
import { IUN } from '../generated/pnapi/IUN';
import { FullSentNotificationV21 } from '../generated/pnapi/FullSentNotificationV21';
import { NotificationStatusEnum } from '../generated/pnapi/NotificationStatus';
import { TimelineElementCategoryV20Enum } from '../generated/pnapi/TimelineElementCategoryV20';
import { AuditRecord, Record } from './Repository';
import { Response, UnauthorizedMessageBody } from './types';
import { NotificationRequest } from './NotificationRequest';
import { authorizeApiKey } from './authorize';
import { computeSnapshot } from './Snapshot';
import { DomainEnv } from './DomainEnv';
import { updateTimeline } from './TimelineElement';
import { makeLogger } from '../logger';

export type GetNotificationDetailRecord = AuditRecord & {
  type: 'GetNotificationDetailRecord';
  input: { apiKey: string; iun: IUN };
  output: Response<200, FullSentNotificationV21> | Response<403, UnauthorizedMessageBody> | Response<404>;
};

export const isGetNotificationDetailRecord = (record: Record): O.Option<GetNotificationDetailRecord> =>
  record.type === 'GetNotificationDetailRecord' ? O.some(record) : O.none;

export const makeFullSentNotification =
  (env: DomainEnv) =>
  (notificationRequest: NotificationRequest) =>
  (iun: IUN): FullSentNotificationV21 => 
    pipe(
      {
        ...notificationRequest,
        iun,
        sentAt: env.dateGenerator(),
        notificationStatus: NotificationStatusEnum.ACCEPTED,
        notificationStatusHistory: [],
        documentsAvailable: true,
        timeline: [],
        senderPaId: env.senderPAId,
      },
      (notification) => updateTimeline(env)(notification, notification.notificationStatus)
    );

    const log = makeLogger();
const exactFullSentNotification = (env: DomainEnv, notification: FullSentNotificationV21): FullSentNotificationV21 => {
  log.info("STATO exactFullSentNotification: ", notification.notificationStatus);
  return ({
  // Remove all the properties not defined by FullSentNotificationV21 type
  ...t.exact(FullSentNotificationV21).encode(notification),
  // The encode of FullSentNotificationV21 converts Date to a string.
  // Quick workaround: just copy them from the original input
  notificationStatus: notification.notificationStatus,
  sentAt: notification.sentAt,
  notificationStatusHistory: notification.notificationStatusHistory,
  timeline: notification.notificationStatus === NotificationStatusEnum.CANCELLED ? [
    ...notification.timeline,
    {
      elementId: `NOTIFICATION_CANCELLATION_REQUEST.IUN_${notification.iun}`,
      timestamp: env.dateGenerator(),
      legalFactsIds: [],
      category: TimelineElementCategoryV20Enum.NOTIFICATION_CANCELLATION_REQUEST,
      details: {
        cancellationRequestId: "90e3f130-cb23-4b6b-a0aa-858de7ffb3a0"
      }
    },
    {
      elementId: `NOTIFICATION_CANCELLED.IUN_${notification.iun}`,
      timestamp: env.dateGenerator(),
      legalFactsIds: [],
      category: TimelineElementCategoryV20Enum.NOTIFICATION_CANCELLED,
      details: {
        notificationCost: 100,
        notRefinedRecipientIndexes: [0]
      }
    }
  ] : notification.timeline
});
};

export const makeGetNotificationDetailRecord =
  (env: DomainEnv) =>
  (input: GetNotificationDetailRecord['input']) =>
  (records: ReadonlyArray<Record>): GetNotificationDetailRecord => ({
    type: 'GetNotificationDetailRecord',
    input,
    loggedAt: env.dateGenerator(),
    output: pipe(
      authorizeApiKey(input.apiKey),
      E.map(() =>
        pipe(
          computeSnapshot(env)(records),
          RA.filterMap(O.fromEither),
          RA.findFirstMap((notification) => {
            const getNotificationDetailRecord: GetNotificationDetailRecord = (records.filter(singleRecord => singleRecord.type === 'GetNotificationDetailRecord')[0] as GetNotificationDetailRecord);
            if (getNotificationDetailRecord !== undefined) {
              const deletedFullSentNotificationV21: FullSentNotificationV21 = getNotificationDetailRecord.output.returned as FullSentNotificationV21;
              log.info("INTERN: ", deletedFullSentNotificationV21.notificationStatus);
              if (notification.iun === deletedFullSentNotificationV21.iun && deletedFullSentNotificationV21.notificationStatus === NotificationStatusEnum.CANCELLED) {
                notification.notificationStatus = NotificationStatusEnum.CANCELLED;
                notification.cancelledIun = notification.iun;
                notification.notificationStatusHistory = [
                  ...notification.notificationStatusHistory,
                  {
                    status: NotificationStatusEnum.CANCELLED,
                    activeFrom: env.dateGenerator(),
                    relatedTimelineElements: [
                      `NOTIFICATION_CANCELLED.IUN_${notification.iun}`
                    ]
                  }
                ];
              }
            }
            return notification.iun === input.iun ? O.some(exactFullSentNotification(env, notification)) : O.none;
          }),
          O.map((returned) => ({ statusCode: 200 as const, returned })),
          O.getOrElseW(() => ({ statusCode: 404 as const, returned: undefined }))
        )
      ),
      E.toUnion
    ),
  });
