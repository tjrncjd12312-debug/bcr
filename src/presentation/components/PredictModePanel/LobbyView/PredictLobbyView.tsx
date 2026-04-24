import { memo } from 'react'
import type { Room, RoomPredictionState } from '../../../../domain/entities'
import RoomThumbnailCard from './RoomThumbnailCard'
import './PredictLobbyView.css'

interface PredictLobbyViewProps {
  rooms: Room[]
  roomStates: Map<string, RoomPredictionState>
  selectedRoom: Room | null
  onRoomSelect: (room: Room) => void
  onEnterRoom: (roomId: string) => void
  getMartinLevel: (roomId: string) => number | undefined
}

const PredictLobbyView = memo(function PredictLobbyView({
  rooms,
  roomStates,
  selectedRoom,
  onRoomSelect,
  onEnterRoom,
  getMartinLevel
}: PredictLobbyViewProps) {
  return (
    <div className="lobby-v3-grid">
      {rooms.map(room => (
        <RoomThumbnailCard
          key={room.id}
          room={room}
          state={roomStates.get(room.id)}
          isSelected={selectedRoom?.id === room.id}
          onSelect={onRoomSelect}
          onEnter={onEnterRoom}
          martinLevel={getMartinLevel(room.id)}
        />
      ))}
    </div>
  )
})

export default PredictLobbyView
