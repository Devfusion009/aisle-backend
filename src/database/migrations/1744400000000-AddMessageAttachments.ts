import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: Add `attachments` JSONB column to the messages table so user
 * messages can carry inline image data-URLs that the chat UI renders as
 * thumbnails above the bubble text.
 */
export class AddMessageAttachments1744400000000 implements MigrationInterface {
  name = 'AddMessageAttachments1744400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "messages"
        ADD COLUMN IF NOT EXISTS "attachments" jsonb NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "messages"
        DROP COLUMN IF EXISTS "attachments"
    `);
  }
}
