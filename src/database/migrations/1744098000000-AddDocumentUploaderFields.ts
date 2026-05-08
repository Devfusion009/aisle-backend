import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: Add uploadedBy and uploadedByName fields to the documents table.
 * These fields track which user uploaded a document (for display in the Knowledge Base UI).
 */
export class AddDocumentUploaderFields1744098000000
  implements MigrationInterface
{
  name = 'AddDocumentUploaderFields1744098000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "documents"
        ADD COLUMN IF NOT EXISTS "uploadedBy" uuid NULL,
        ADD COLUMN IF NOT EXISTS "uploadedByName" character varying(255) NULL
    `);

    await queryRunner.query(`
      ALTER TABLE "documents"
        ADD CONSTRAINT "FK_documents_uploadedBy"
        FOREIGN KEY ("uploadedBy") REFERENCES "users"("id")
        ON DELETE SET NULL
        DEFERRABLE INITIALLY DEFERRED
        NOT VALID
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "documents"
        DROP CONSTRAINT IF EXISTS "FK_documents_uploadedBy"
    `);
    await queryRunner.query(`
      ALTER TABLE "documents"
        DROP COLUMN IF EXISTS "uploadedByName",
        DROP COLUMN IF EXISTS "uploadedBy"
    `);
  }
}
