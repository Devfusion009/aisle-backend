import {
  EventSubscriber,
  EntitySubscriberInterface,
  InsertEvent,
  UpdateEvent,
} from 'typeorm';
import { validate } from 'class-validator';
import { BadRequestException } from '@nestjs/common';

/**
 * ValidationSubscriber
 *
 * Runs class-validator's validate() on every entity before insert and update.
 * This complements DTO-level validation by catching data inconsistencies
 * at the persistence layer — ensuring data makes sense from origin to database.
 */
@EventSubscriber()
export class ValidationSubscriber implements EntitySubscriberInterface {
  async beforeInsert(event: InsertEvent<any>): Promise<void> {
    await this.validateEntity(event.entity);
  }

  async beforeUpdate(event: UpdateEvent<any>): Promise<void> {
    // event.entity may be a partial update (e.g. { isActive: false })
    // Only validate if we have a full entity instance with a constructor
    if (event.entity && event.entity.constructor !== Object) {
      await this.validateEntity(event.entity);
    }
  }

  private async validateEntity(entity: any): Promise<void> {
    if (!entity) return;

    const errors = await validate(entity, {
      skipMissingProperties: true,
      whitelist: false,
      forbidNonWhitelisted: false,
    });

    if (errors.length > 0) {
      const messages = errors.flatMap((error) =>
        Object.values(error.constraints || {}),
      );
      throw new BadRequestException(
        `Entity validation failed: ${messages.join('; ')}`,
      );
    }
  }
}
