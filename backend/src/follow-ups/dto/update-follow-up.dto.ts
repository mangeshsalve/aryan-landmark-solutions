import { PartialType } from '@nestjs/swagger';
import { CreateFollowUpDto } from './create-follow-up.dto';

/**
 * Matches components.schemas.UpdateFollowUpRequest in
 * docs/api/openapi.yaml — everything from CreateFollowUpDto, all
 * optional. This single endpoint also covers "complete a follow-up"
 * (PATCH { status: 'COMPLETED' }) — no separate complete/status endpoint,
 * since (unlike Inquiry.submit(), which enforces the ADMIN-recording
 * business rule) a follow-up's PENDING->COMPLETED transition has no
 * extra precondition to check.
 */
export class UpdateFollowUpDto extends PartialType(CreateFollowUpDto) {}
