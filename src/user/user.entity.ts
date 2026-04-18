import { Column, Entity, PrimaryGeneratedColumn } from "typeorm";


@Entity()
export class User {
    @PrimaryGeneratedColumn()
    id:number;
    @Column({
        type:"varchar",
        nullable:false,
        length:20
    })
    firstName:string;
    @Column({
        type:"varchar",
        nullable:false,
        length:20
    })
    lastName:string;

    @Column({
        type:"varchar",
        nullable:false,
        length:20,
        unique:true
    })
    email:string;

    @Column({
        type:"varchar",
        nullable:false,
        length:20
    })
    password:string

    @Column({
        type:"varchar",
        nullable:true,
        length:20
    })
    gender:string;

}